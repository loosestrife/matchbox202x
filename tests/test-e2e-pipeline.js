// test-e2e-pipeline.js - E2E System Integration Test Suite with Timeouts & TTS/XAudio Pipeline
const assert = require('assert');
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const HTTP_PORT = 12345;
const HTTP_BASE_URL = `http://localhost:${HTTP_PORT}`;
const GLOBAL_TIMEOUT_MS = 60000;
const STEP_EXEC_TIMEOUT_MS = 20000;
const HTTP_REQ_TIMEOUT_MS = 30000;

let xvfbProc = null;
let lighterProc = null;
let clipsProc = null;
let ttsProc = null;
let globalTimeoutTimer = null;

function parseMultipartResponse(responseText) {
  if (!responseText || typeof responseText !== 'string') return [];
  const lines = responseText.split(/\r?\n/);
  const boundaryLine = lines.find(l => l.startsWith('--MatchboxFrameBoundary') || l.startsWith('--'));
  if (!boundaryLine) return [];
  const boundary = boundaryLine.trim();
  const rawParts = responseText.split(boundary).filter(p => p.trim() && p.trim() !== '--');

  return rawParts.map(partStr => {
    const headerEndIdx = partStr.indexOf('\r\n\r\n') !== -1 ? partStr.indexOf('\r\n\r\n') : partStr.indexOf('\n\n');
    if (headerEndIdx === -1) {
      return { headers: {}, body: partStr.trim() };
    }
    const headerBlock = partStr.slice(0, headerEndIdx);
    const bodyBlock = partStr.slice(headerEndIdx).replace(/^(\r?\n)+/, '').replace(/(\r?\n)+$/, '');
    const headers = {};
    headerBlock.split(/\r?\n/).forEach(hLine => {
      const idx = hLine.indexOf(':');
      if (idx !== -1) {
        headers[hLine.slice(0, idx).trim().toLowerCase()] = hLine.slice(idx + 1).trim();
      }
    });
    return { headers, body: bodyBlock };
  });
}

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

function httpRequest(method, urlPath, headers = {}, body = null, timeoutMs = HTTP_REQ_TIMEOUT_MS) {
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
      req.setTimeout(0); // Clear request timeout once response headers arrive
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const resBody = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: resBody });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP request ${method} ${urlPath} timed out after ${timeoutMs}ms`));
    });

    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function cleanup() {
  if (globalTimeoutTimer) clearTimeout(globalTimeoutTimer);
  console.log('[Cleanup] Terminating spawned child processes...');
  if (ttsProc) {
    try { ttsProc.kill('SIGKILL'); } catch (_) {}
  }
  if (clipsProc) {
    try { clipsProc.kill('SIGKILL'); } catch (_) {}
  }
  if (lighterProc) {
    try { lighterProc.kill('SIGKILL'); } catch (_) {}
  }
  if (xvfbProc) {
    try { xvfbProc.kill('SIGKILL'); } catch (_) {}
  }
  try {
    execSync('fuser -k 12345/tcp 2>/dev/null || true');
  } catch (_) {}
  await new Promise(r => setTimeout(r, 300));
}

async function runE2EPipeline() {
  console.log('=== Starting E2E System Integration Test Pipeline ===');

  // Kill any stale background listeners on port 12345
  try {
    execSync('fuser -k 12345/tcp 2>/dev/null || true');
  } catch (_) {}

  // Set mock audio player command for cool-service-lighter xaudio-node
  process.env.AUDIO_PLAYER_CMD = 'node -e "setTimeout(() => process.exit(0), 100)"';

  // Global Safety Timeout Guard
  globalTimeoutTimer = setTimeout(async () => {
    console.error(`\n!!! GLOBAL PIPELINE TIMEOUT EXCEEDED (${GLOBAL_TIMEOUT_MS / 1000}s) !!!`);
    await cleanup();
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  // Step 1: Headless X11 Display Setup (Spawns Xvfb if available/requested, falling back to active DISPLAY)
  try {
    if (process.env.USE_XVFB || !process.env.DISPLAY) {
      const displayNum = process.env.XVFB_DISPLAY || ':99';
      xvfbProc = spawn('Xvfb', [displayNum, '-screen', '0', '1280x1024x24'], { stdio: 'ignore' });
      xvfbProc.on('error', () => {
        xvfbProc = null;
      });
      await new Promise(r => setTimeout(r, 500));
      if (xvfbProc && !xvfbProc.killed) {
        process.env.DISPLAY = displayNum;
        console.log(`[Step 1] Successfully launched headless Xvfb process on DISPLAY=${process.env.DISPLAY}`);
      }
    }
  } catch (_) {}

  if (!process.env.DISPLAY) {
    process.env.DISPLAY = ':0';
  }
  console.log(`[Step 1] Using DISPLAY=${process.env.DISPLAY}`);

  // Step 2: Spawn cool-service-lighter supervisor
  console.log('[Step 2] Spawning cool-service-lighter supervisor...');
  const lighterScript = path.join(__dirname, '..', 'cool-service-lighter', 'index.js');
  lighterProc = spawn('node', [lighterScript], {
    cwd: path.join(__dirname, '..', 'cool-service-lighter'),
    env: { ...process.env },
    stdio: 'ignore'
  });

  // Step 3: Wait for HTTP bridge readiness
  console.log('[Step 3] Polling for cool-http-bridge readiness on port 12345...');
  await pollHttpReady();
  console.log('[Step 3] cool-http-bridge is active and responsive!');

  // Step 3.5: Spawn cool-clips clipboard daemon
  console.log('[Step 3.5] Spawning cool-clips clipboard daemon...');
  const clipsScript = path.join(__dirname, '..', 'cool-clips.js');
  clipsProc = spawn('node', [clipsScript], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env },
    stdio: 'ignore'
  });

  // Step 3.6: Spawn mock-tts-server daemon
  console.log('[Step 3.6] Spawning mock-tts-server daemon...');
  const ttsScript = path.join(__dirname, 'mock-tts.js');
  ttsProc = spawn('node', [ttsScript], {
    cwd: __dirname,
    env: { ...process.env },
    stdio: 'ignore'
  });
  await new Promise(r => setTimeout(r, 2000));

  // Step 4: Execute final-copy.js (Copy Payload - Mode A)
  const testPayloadA = 'E2E Integration Payload Mode A - ' + Date.now();
  console.log(`[Step 4] Executing final-copy.js --echo "${testPayloadA}"`);
  execSync(`node "${path.join(__dirname, '..', 'final-copy.js')}" --echo "${testPayloadA}"`, {
    env: { ...process.env },
    timeout: STEP_EXEC_TIMEOUT_MS,
    stdio: 'ignore'
  });
  console.log('[Step 4] final-copy.js completed successfully!');

  // Step 5: Mock Web Card Paste Test - Mode A (Inline Multipart Stream)
  console.log('[Step 5] Mock Web Card issuing ui.Paste (Mode A: Default Multipart Stream)...');
  const pasteResA = await httpRequest('POST', '/intent/ui/Paste', { Accept: 'multipart/mixed' }, { intent: 'ui.Paste' });
  assert.strictEqual(pasteResA.statusCode, 200, 'ui.Paste Mode A should return status 200');

  const partsA = parseMultipartResponse(pasteResA.body);
  assert(partsA.length >= 2, 'Mode A multipart stream should contain at least 2 parts (JSON frame + XBlob frame)');

  // Verify Part 2 inline data blob content
  const fullBodyA = pasteResA.body;
  assert(fullBodyA.includes('E2E Integration Payload'), 'Mode A multipart response body should contain payload header');
  console.log('  -> Mode A (Default Inline Multipart Stream) PASSED!');

  // Step 6: Execute final-copy.js (Copy Payload - Mode B)
  const testPayloadB = 'E2E Integration Payload Mode B - ' + Date.now();
  console.log(`\n[Step 6] Executing final-copy.js --echo "${testPayloadB}"`);
  execSync(`node "${path.join(__dirname, '..', 'final-copy.js')}" --echo "${testPayloadB}"`, {
    env: { ...process.env },
    timeout: STEP_EXEC_TIMEOUT_MS,
    stdio: 'ignore'
  });

  // Step 7: Mock Web Card Paste Test - Mode B (Prefer: return=minimal + GET /blobs + DELETE /blobs)
  console.log('[Step 7] Mock Web Card issuing ui.Paste with Prefer: return=minimal...');
  const pasteResB = await httpRequest('POST', '/intent/ui/Paste', { Accept: 'multipart/mixed', Prefer: 'return=minimal' }, { intent: 'ui.Paste', Prefer: 'return=minimal' });
  assert.strictEqual(pasteResB.statusCode, 200, 'ui.Paste Mode B should return status 200');

  const partsB = parseMultipartResponse(pasteResB.body);
  const jsonHeaderBlob = partsB[0]?.headers?.['x-attached-blob-id'];

  let minimalJson = {};
  try {
    minimalJson = JSON.parse(pasteResB.body);
  } catch (_) {
    if (partsB[0]) {
      try { minimalJson = JSON.parse(partsB[0].body); } catch (_) {}
    }
  }

  const blobId = jsonHeaderBlob || minimalJson.blob || minimalJson.dataBlob || minimalJson.data?.blob || minimalJson.data?.dataBlob || minimalJson.XBlob;
  assert(blobId, 'Mode B JSON response should contain blob ID');
  const hexBlobId = typeof blobId === 'number' ? `0x${blobId.toString(16)}` : String(blobId);
  console.log(`  -> Received minimal payload with blob ID ${hexBlobId}`);

  // Fetch blob explicitly via GET /blobs/:blobId
  console.log(`[Step 8] Fetching blob explicitly via GET /blobs/${hexBlobId}...`);
  const getBlobRes = await httpRequest('GET', `/blobs/${hexBlobId}`);
  assert.strictEqual(getBlobRes.statusCode, 200, 'GET /blobs should return status 200');
  assert(getBlobRes.body.includes('E2E Integration Payload'), 'Explicit GET /blobs payload should contain Mode B text');
  console.log('  -> Explicit GET /blobs PASSED!');

  // Unlink blob explicitly via DELETE /blobs/:blobId
  console.log(`[Step 9] Unlinking blob explicitly via DELETE /blobs/${hexBlobId}...`);
  const deleteBlobRes = await httpRequest('DELETE', `/blobs/${hexBlobId}`);
  assert.strictEqual(deleteBlobRes.statusCode, 200, 'DELETE /blobs should return status 200');
  const deleteJson = JSON.parse(deleteBlobRes.body);
  assert.strictEqual(deleteJson.status, 'ok', 'DELETE /blobs should return status ok');
  console.log('  -> Explicit DELETE /blobs PASSED!');

  // Step 10: TTS Generation Test
  console.log('\n[Step 10] Issuing ui.TextToSpeech intent to mock-tts-server...');
  const ttsRes = await httpRequest(
    'POST',
    '/intent/ui/TextToSpeech?app=mock-tts-server',
    { Accept: 'multipart/mixed' },
    { intent: 'ui.TextToSpeech', text: 'Hello E2E Audio Pipeline' }
  );
  assert.strictEqual(ttsRes.statusCode, 200, 'ui.TextToSpeech should return status 200');

  const ttsParts = parseMultipartResponse(ttsRes.body);
  let ttsAudioBlob = ttsParts[0]?.headers?.['x-attached-blob-id'];

  if (!ttsAudioBlob && ttsRes.headers['x-attached-blob-id']) {
    ttsAudioBlob = ttsRes.headers['x-attached-blob-id'];
  }
  if (!ttsAudioBlob) {
    try {
      const ttsJson = JSON.parse(ttsParts[0]?.body || ttsRes.body);
      ttsAudioBlob = ttsJson.blob || ttsJson.data_blob || ttsJson.dataBlob;
    } catch (_) {}
  }

  assert(ttsAudioBlob, 'ui.TextToSpeechResponse should return audio WAV blob ID header/property');
  const ttsHexBlobId = typeof ttsAudioBlob === 'number' ? `0x${ttsAudioBlob.toString(16)}` : String(ttsAudioBlob);
  console.log(`  -> ui.TextToSpeechResponse returned audio WAV blob ID ${ttsHexBlobId}`);

  // Step 11 & 12: XAudio Playback & Response Assertion
  console.log(`[Step 11] Issuing xaudio.PlaySoundBlob to SESSION_SPEAKERS with blob ${ttsHexBlobId}...`);
  const playRes = await httpRequest(
    'POST',
    '/intent/xaudio/PlaySoundBlob',
    {
      Accept: 'multipart/mixed',
      'X-Channel-Control': 'SYN',
      'X-Attached-Blob-Id': ttsHexBlobId,
    },
    {
      intent: 'xaudio.PlaySoundBlob',
    }
  );

  assert.strictEqual(playRes.statusCode, 200, 'xaudio.PlaySoundBlob should return status 200');

  let playJson = {};
  const playParts = parseMultipartResponse(playRes.body);
  try {
    playJson = JSON.parse(playParts[0]?.body || playRes.body);
  } catch (_) {}

  assert.strictEqual(playJson.status, 200, 'XAudioPlayResponseV0 status should be 200');
  assert(playJson.OutputId && playJson.OutputId.includes('speakers'), 'XAudioPlayResponseV0 OutputId should contain the active sink speakers name');
  console.log(`  -> XAudioPlayResponseV0 returned status 200 with OutputId '${playJson.OutputId}' from mock audio player!`);

  console.log('\n=======================================================');
  console.log('=== ALL E2E SYSTEM INTEGRATION TESTS PASSED GREEN! ===');
  console.log('=======================================================\n');
}

runE2EPipeline()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n!!! E2E PIPELINE FAILURE !!!\n', err);
    await cleanup();
    process.exit(1);
  });
