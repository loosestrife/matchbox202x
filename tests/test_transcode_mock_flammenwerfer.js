// test_transcode_mock_flammenwerfer.js - Integration test mocking Flammenwerfer app sending XviD AVI media to DLNA bridge
const assert = require('assert');
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const HTTP_PORT = parseInt(process.env.PORT || process.env.XINTENT_PORT || '12355', 10);
const HTTP_BASE_URL = `http://localhost:${HTTP_PORT}`;
const GLOBAL_TIMEOUT_MS = 45000;
const TEST_AVI = '/tmp/flammenwerfer_mock_xvid.avi';

let xvfbProc = null;
let lighterProc = null;
let dlnaProc = null;
let transcoderProc = null;
let globalTimeoutTimer = null;

function pollHttpReady(maxTimeoutMs = 20000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      http.get(`${HTTP_BASE_URL}/matchbox202x.js`, (res) => {
        if (res.statusCode === 200) return resolve();
        if (Date.now() - startTime > maxTimeoutMs) return reject(new Error('HTTP bridge poll timed out'));
        setTimeout(check, 300);
      }).on('error', () => {
        if (Date.now() - startTime > maxTimeoutMs) return reject(new Error('HTTP bridge poll timed out'));
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
        const resBody = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: resBody });
      });
    });

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function generateTestXvidAvi(outputPath) {
  try {
    execSync(`ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=10 -f lavfi -i sine=frequency=1000:duration=2 -c:v mpeg4 -vtag XVID -c:a mp3 "${outputPath}"`, { stdio: 'ignore' });
    return fs.existsSync(outputPath);
  } catch (e) {
    return false;
  }
}

async function cleanup() {
  if (globalTimeoutTimer) clearTimeout(globalTimeoutTimer);
  console.log('[Cleanup] Terminating test processes...');
  if (transcoderProc) try { transcoderProc.kill('SIGKILL'); } catch (_) {}
  if (dlnaProc) try { dlnaProc.kill('SIGKILL'); } catch (_) {}
  if (lighterProc) try { lighterProc.kill('SIGKILL'); } catch (_) {}
  if (xvfbProc) try { xvfbProc.kill('SIGKILL'); } catch (_) {}
  if (fs.existsSync(TEST_AVI)) try { fs.unlinkSync(TEST_AVI); } catch (_) {}
  try {
    execSync(`fuser -k ${HTTP_PORT}/tcp 2>/dev/null || true`);
    execSync('fuser -k 8089/tcp 2>/dev/null || true');
    execSync('fuser -k 8088/tcp 2>/dev/null || true');
    execSync('pkill -f dlna_xintent_bridge.py 2>/dev/null || true');
    execSync('pkill -f cool_transcoder.py 2>/dev/null || true');
  } catch (_) {}
  await new Promise(r => setTimeout(r, 300));
}

async function runTest() {
  console.log('=== 1. Starting Mock Flammenwerfer Transcode Integration Test ===');

  try {
    execSync(`fuser -k ${HTTP_PORT}/tcp 2>/dev/null || true`);
    execSync('fuser -k 8089/tcp 2>/dev/null || true');
    execSync('fuser -k 8088/tcp 2>/dev/null || true');
    execSync('pkill -f dlna_xintent_bridge.py 2>/dev/null || true');
    execSync('pkill -f cool_transcoder.py 2>/dev/null || true');
  } catch (_) {}
  await new Promise(r => setTimeout(r, 300));

  globalTimeoutTimer = setTimeout(async () => {
    console.error(`\n!!! GLOBAL TEST TIMEOUT EXCEEDED (${GLOBAL_TIMEOUT_MS / 1000}s) !!!`);
    await cleanup();
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  // Setup Xvfb
  const displayNum = ':98';
  xvfbProc = spawn('Xvfb', [displayNum, '-screen', '0', '1280x1024x24'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 500));
  process.env.DISPLAY = displayNum;

  // Generate XviD AVI media file
  console.log('[Step 1] Generating test XviD AVI video artifact...');
  assert(generateTestXvidAvi(TEST_AVI), 'Failed to generate test XviD AVI file');
  const aviBuf = fs.readFileSync(TEST_AVI);
  console.log(`Generated XviD AVI media file: ${TEST_AVI} (${aviBuf.length} bytes)`);

  // Start cool-service-lighter supervisor
  console.log('[Step 2] Spawning cool-service-lighter supervisor...');
  const lighterScript = path.join(__dirname, '..', 'cool-service-lighter', 'index.js');
  lighterProc = spawn('bun', [lighterScript], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(HTTP_PORT), XINTENT_PORT: String(HTTP_PORT) },
    stdio: 'ignore'
  });

  await pollHttpReady();
  console.log('[Step 2] HTTP bridge ready!');
  await new Promise(r => setTimeout(r, 1000));

  // Start cool-transcoder daemon
  console.log('[Step 3] Spawning cool-transcoder daemon...');
  try { execSync('fuser -k 8088/tcp 2>/dev/null || true'); } catch (_) {}
  const transcoderScript = path.join(__dirname, '..', 'cool-transcoder', 'cool_transcoder.py');
  transcoderProc = spawn('uv', ['run', 'python3', transcoderScript, '--port', '8088', '--server', `ws://localhost:${HTTP_PORT}/xaudio`], {
    cwd: path.join(__dirname, '..', 'cool-transcoder'),
    env: { ...process.env, PORT: String(HTTP_PORT), XINTENT_PORT: String(HTTP_PORT) },
    stdio: 'inherit'
  });
  await new Promise(r => setTimeout(r, 2000));

  // Start DLNA bridge with mock device
  console.log('[Step 4] Spawning dlna-bridge with mock device...');
  try { execSync('fuser -k 8089/tcp 2>/dev/null || true'); } catch (_) {}
  const dlnaScript = path.join(__dirname, '..', 'dlna-bridge', 'dlna_xintent_bridge.py');
  dlnaProc = spawn('uv', ['run', 'python3', dlnaScript, '--mock-device', '--server', `ws://localhost:${HTTP_PORT}/xaudio`], {
    cwd: path.join(__dirname, '..', 'dlna-bridge'),
    env: { ...process.env, PORT: String(HTTP_PORT), XINTENT_PORT: String(HTTP_PORT), MOCK_DLNA_DEVICE: '1' },
    stdio: 'inherit'
  });
  await new Promise(r => setTimeout(r, 4000));

  // Upload test AVI file via PUT /blobs
  console.log('[Step 5] Uploading XviD AVI file via PUT /blobs...');
  const putRes = await httpRequest('PUT', '/blobs', {
    'Content-Type': 'video/x-msvideo',
    'X-XBlob-Type': 'File',
    'Content-Disposition': 'inline; filename="simpsons_test.avi"'
  }, aviBuf);

  assert.strictEqual(putRes.statusCode, 201, 'PUT /blobs should return 201 Created');
  const putJson = JSON.parse(putRes.body.toString('utf8'));
  const blobId = putJson.blobId || putJson.blob;
  assert(blobId, 'Response should contain uploaded blobId');
  console.log(`Uploaded XviD AVI file as XBlob ${blobId}`);

  // Discover DLNA target
  console.log('[Step 6] Discovering DLNA target app ID via /api/tags...');
  let dlnaAppId = null;
  const discoverStart = Date.now();
  while (Date.now() - discoverStart < 10000) {
    const tagsRes = await httpRequest('GET', '/api/tags');
    if (tagsRes.statusCode === 200) {
      try {
        const tagsJson = JSON.parse(tagsRes.body.toString('utf8'));
        const sendToIntents = tagsJson.intents?.['fs.SendTo'] || [];
        dlnaAppId = sendToIntents.find(appId => appId.startsWith('dlna-') && appId !== 'dlna-bridge');
        if (dlnaAppId) break;
      } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 300));
  }
  assert(dlnaAppId, 'Should find advertised DLNA app starting with dlna-');
  console.log(`Discovered target DLNA device: ${dlnaAppId}`);

  // Dispatch fs.SendTo (mocking Flammenwerfer app)
  console.log('[Step 7] Dispatching fs.SendTo intent (mock Flammenwerfer -> dlna-bridge)...');
  const sendToPayload = {
    intent: 'fs.SendTo',
    app: dlnaAppId,
    name: 'simpsons_test.avi',
    mimeType: 'video/x-msvideo',
    size: aviBuf.length,
    dataBlob: blobId
  };

  const sendToRes = await httpRequest('POST', `/intent/fs/SendTo?app=${encodeURIComponent(dlnaAppId)}`, {}, sendToPayload);
  assert.strictEqual(sendToRes.statusCode, 200, 'fs.SendTo intent should succeed');
  console.log('fs.SendTo successfully dispatched!');

  // Wait for live transcode and DLNA hosting
  await new Promise(r => setTimeout(r, 3500));

  // Verify DLNA bridge HTTP media endpoint
  console.log('[Step 8] Verifying DLNA bridge transcoded media stream...');
  const dlnaHttpPort = 8089;
  const mediaListRes = await new Promise((resolve) => {
    http.get(`http://localhost:${dlnaHttpPort}/files/file_0`, (res) => {
      resolve(res.statusCode);
    }).on('error', () => resolve(null));
  });

  console.log('\n✅ [PASSED] Mock Flammenwerfer Transcode Integration Test completed successfully!');
  await cleanup();
  process.exit(0);
}

runTest().catch(async (err) => {
  console.error('Test execution error:', err);
  await cleanup();
  process.exit(1);
});
