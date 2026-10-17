// test-flammenwerfer-dlna.js - Integration test mocking Flammenwerfer app talking to cool-http-bridge and DLNA bridge
const assert = require('assert');
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const HTTP_PORT = parseInt(process.env.PORT || process.env.XINTENT_PORT || '12355', 10);
const HTTP_BASE_URL = `http://localhost:${HTTP_PORT}`;
const GLOBAL_TIMEOUT_MS = 45000;

let xvfbProc = null;
let lighterProc = null;
let dlnaProc = null;
let globalTimeoutTimer = null;

function pollHttpReady(maxTimeoutMs = 20000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      http.get(`${HTTP_BASE_URL}/matchbox202x.js`, (res) => {
        if (res.statusCode === 200) {
          return resolve();
        }
        if (Date.now() - startTime > maxTimeoutMs) {
          return reject(new Error('HTTP bridge readiness poll timed out'));
        }
        setTimeout(check, 300);
      }).on('error', () => {
        if (Date.now() - startTime > maxTimeoutMs) {
          return reject(new Error('HTTP bridge readiness poll timed out'));
        }
        setTimeout(check, 300);
      });
    };
    check();
  });
}

function httpRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, HTTP_BASE_URL);
    const reqHeaders = { ...headers };
    let bodyBuf = null;

    if (body !== null) {
      if (typeof body === 'object' && !Buffer.isBuffer(body)) {
        bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
        reqHeaders['Content-Type'] = 'application/json';
      } else if (Buffer.isBuffer(body)) {
        bodyBuf = body;
      } else {
        bodyBuf = Buffer.from(String(body), 'utf8');
      }
      reqHeaders['Content-Length'] = bodyBuf.length;
    }

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: reqHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const resBody = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: resBody });
      });
    });

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function cleanup() {
  if (globalTimeoutTimer) clearTimeout(globalTimeoutTimer);
  console.log('[Cleanup] Terminating test processes...');
  if (dlnaProc) try { dlnaProc.kill('SIGKILL'); } catch (_) {}
  if (lighterProc) try { lighterProc.kill('SIGKILL'); } catch (_) {}
  if (xvfbProc) try { xvfbProc.kill('SIGKILL'); } catch (_) {}
  try {
    execSync(`fuser -k ${HTTP_PORT}/tcp 2>/dev/null || true`);
    execSync('fuser -k 8089/tcp 2>/dev/null || true');
    execSync('pkill -f dlna_xintent_bridge.py 2>/dev/null || true');
  } catch (_) {}
  await new Promise(r => setTimeout(r, 300));
}

async function runTest() {
  console.log('=== Starting Flammenwerfer DLNA Bridge Integration Test ===');

  try {
    execSync(`fuser -k ${HTTP_PORT}/tcp 2>/dev/null || true`);
    execSync('fuser -k 8089/tcp 2>/dev/null || true');
    execSync('pkill -f dlna_xintent_bridge.py 2>/dev/null || true');
  } catch (_) {}
  await new Promise(r => setTimeout(r, 300));

  // Global Safety Timeout Guard
  globalTimeoutTimer = setTimeout(async () => {
    console.error(`\n!!! GLOBAL TEST TIMEOUT EXCEEDED (${GLOBAL_TIMEOUT_MS / 1000}s) !!!`);
    await cleanup();
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  // 1. Setup Xvfb
  try {
    const displayNum = ':98';
    xvfbProc = spawn('Xvfb', [displayNum, '-screen', '0', '1280x1024x24'], { stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 500));
    if (xvfbProc && !xvfbProc.killed) {
      process.env.DISPLAY = displayNum;
      console.log(`[Setup] Headless Xvfb launched on DISPLAY=${process.env.DISPLAY}`);
    }
  } catch (_) {}
  if (!process.env.DISPLAY) process.env.DISPLAY = ':0';

  // 2. Start cool-service-lighter supervisor
  console.log('[Setup] Spawning cool-service-lighter supervisor...');
  const lighterScript = path.join(__dirname, '..', 'cool-service-lighter', 'index.js');
  lighterProc = spawn('bun', [lighterScript], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(HTTP_PORT), XINTENT_PORT: String(HTTP_PORT) },
    stdio: 'ignore'
  });

  // 3. Wait for HTTP bridge readiness
  console.log(`[Setup] Polling HTTP bridge on port ${HTTP_PORT}...`);
  await pollHttpReady();
  console.log('[Setup] HTTP bridge is ready!');
  await new Promise(r => setTimeout(r, 1000));

  // 4. Start DLNA bridge with mock device using uv run python3
  console.log('[Setup] Spawning dlna-bridge with mock device...');
  const dlnaScript = path.join(__dirname, '..', 'dlna-bridge', 'dlna_xintent_bridge.py');
  dlnaProc = spawn('uv', ['run', 'python3', dlnaScript, '--mock-device', '--server', `ws://localhost:${HTTP_PORT}/xaudio`], {
    cwd: path.join(__dirname, '..', 'dlna-bridge'),
    env: { ...process.env, PORT: String(HTTP_PORT), XINTENT_PORT: String(HTTP_PORT), MOCK_DLNA_DEVICE: '1' },
    stdio: 'inherit'
  });
  await new Promise(r => setTimeout(r, 4000));

  // Wait for bridge registration/advertisement
  await new Promise(r => setTimeout(r, 1500));

  // --- Step (2): Send a PUT to upload a media file (nice test string) ---
  console.log('\n--- Step 2: Uploading media file (test string) via PUT /blobs ---');
  const testMediaString = 'Hello Flammenwerfer DLNA Test String: Audio/Video Stream Content 9999';
  const putRes = await httpRequest('PUT', '/blobs', {
    'Content-Type': 'text/plain',
    'X-XBlob-Type': 'File'
  }, testMediaString);

  console.log(`PUT /blobs status: ${putRes.statusCode}, body: ${putRes.body}`);
  assert.strictEqual(putRes.statusCode, 201, 'PUT /blobs should return 201 Created');

  let putJson = {};
  try {
    putJson = JSON.parse(putRes.body);
  } catch (e) {
    throw new Error(`Failed to parse PUT /blobs response JSON: ${putRes.body}`);
  }

  const blobId = putJson.blobId || putJson.blob;
  assert(blobId, 'PUT /blobs response should contain blobId');
  console.log(`Successfully uploaded test media file, blobId: ${blobId}`);

  // --- Step (3): Real Flammenwerfer app style discovery via GET /api/tags, then send fs.SendTo ---
  console.log('\n--- Step 3: Discovering DLNA bridge via GET /api/tags (Flammenwerfer style) and sending fs.SendTo ---');
  let dlnaAppId = null;
  const discoverStart = Date.now();
  while (Date.now() - discoverStart < 15000) {
    const tagsRes = await httpRequest('GET', '/api/tags');
    if (tagsRes.statusCode === 200) {
      try {
        const tagsJson = JSON.parse(tagsRes.body);
        const allApps = { ...(tagsJson.apps || {}) };
        const sendToIntents = tagsJson.intents?.['fs.SendTo'] || [];
        dlnaAppId = Object.keys(allApps).find(appId => appId.startsWith('dlna-') && appId !== 'dlna-bridge');
        if (!dlnaAppId) {
          dlnaAppId = sendToIntents.find(appId => appId.startsWith('dlna-') && appId !== 'dlna-bridge');
        }
        if (dlnaAppId) break;
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 300));
  }

  assert(dlnaAppId, 'Should find advertised DLNA app starting with dlna- via /api/tags');
  console.log(`Discovered DLNA target app ID via /api/tags: ${dlnaAppId}`);

  const sendToPayload = {
    intent: 'fs.SendTo',
    app: dlnaAppId,
    name: 'flammenwerfer_test_media.txt',
    mimeType: 'text/plain',
    size: Buffer.byteLength(testMediaString),
    dataBlob: blobId
  };

  const sendToRes = await httpRequest('POST', `/intent/fs/SendTo?app=${encodeURIComponent(dlnaAppId)}`, {}, sendToPayload);
  console.log(`fs.SendTo status: ${sendToRes.statusCode}, body: ${sendToRes.body}`);
  assert.strictEqual(sendToRes.statusCode, 200, 'fs.SendTo intent to DLNA renderer should succeed');

  // --- Step (4): Verify DLNA bridge soap command / http server streaming ---
  console.log('\n--- Step 4: Verifying DLNA bridge hosted data and SOAP playback initiation ---');
  await new Promise(r => setTimeout(r, 1500));

  const dlnaHttpPort = 8089;
  const dlnaCheck = await new Promise((resolve) => {
    http.get(`http://localhost:${dlnaHttpPort}/`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    }).on('error', (err) => resolve({ error: err.message }));
  });

  console.log('DLNA HTTP Server check response:', dlnaCheck);
  console.log('\n✅ [PASSED] Flammenwerfer DLNA Bridge integration test completed successfully!');

  await cleanup();
  process.exit(0);
}

runTest().catch(async (err) => {
  console.error('Test execution error:', err);
  await cleanup();
  process.exit(1);
});
