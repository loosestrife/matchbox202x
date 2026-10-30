// test_xhtml_live_migrate.js - End-to-End Test for xhtml.LiveMigrate (XBlob Grant/SoftLink Transfer & XChannel Cork/Redirect)
const assert = require('assert');
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');

const HTTP_PORT = parseInt(process.env.PORT || process.env.XINTENT_PORT || '12355', 10);
const HTTP_BASE_URL = `http://localhost:${HTTP_PORT}`;
const GLOBAL_TIMEOUT_MS = 60000;

let xvfbProc = null;
let lighterProc = null;
let globalTimeoutTimer = null;

function parseMultipartFrames(chunkStr) {
  const frames = [];
  const lines = chunkStr.split(/\r?\n/);
  const boundaryLine = lines.find((l) => l.startsWith('--MatchboxFrameBoundary'));
  if (!boundaryLine) {
    try {
      frames.push(JSON.parse(chunkStr));
    } catch (_) {}
    return frames;
  }
  const boundary = boundaryLine.trim();
  const rawParts = chunkStr.split(boundary).filter((p) => p.trim() && p.trim() !== '--');
  for (const part of rawParts) {
    const splitIdx = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
    if (splitIdx === -1) continue;
    const body = part.slice(splitIdx).trim();
    try {
      frames.push(JSON.parse(body));
    } catch (_) {}
  }
  return frames;
}

function pollHttpReady(maxTimeoutMs = 20000) {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      http.get(`${HTTP_BASE_URL}/matchbox202x.js`, (res) => {
        if (res.statusCode === 200) return resolve();
        if (Date.now() - startTime > maxTimeoutMs) return reject(new Error('HTTP bridge readiness poll timed out'));
        setTimeout(check, 250);
      }).on('error', () => {
        if (Date.now() - startTime > maxTimeoutMs) return reject(new Error('HTTP bridge readiness poll timed out'));
        setTimeout(check, 250);
      });
    };
    check();
  });
}

function httpRequest(method, urlPath, headers = {}, body = null, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, HTTP_BASE_URL);
    const reqHeaders = { ...headers };
    let bodyBuf = null;

    if (body !== null) {
      if (typeof body === 'object' && !Buffer.isBuffer(body)) {
        bodyBuf = Buffer.from(JSON.stringify(body), 'utf8');
        if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
      } else if (Buffer.isBuffer(body)) {
        bodyBuf = body;
      } else {
        bodyBuf = Buffer.from(String(body), 'utf8');
      }
      reqHeaders['Content-Length'] = bodyBuf.length;
    }

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        req.setTimeout(0);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP request ${method} ${urlPath} timed out`));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function startMockStreamService() {
  const { X, root } = await x11.createClientWithPromises();
  await xintent.connectToRouter(X, root);
  const serviceWin = await xintent.createClientWindow(X, root, 'mock-stream-service');

  const toml = `
[app]
id = "mock-stream-service"

[intents."media.StreamJob"]
invocation = "X11"
`;
  X.ChangeProperty(
    0,
    serviceWin,
    xintent.atoms.MATCHBOX_TOML,
    xintent.atoms.STRING,
    8,
    Buffer.from(toml, 'utf8')
  );

  let activeChannel = 0;
  let liveStatusBlob = 0;

  X.on('event', async (ev) => {
    if (ev.type === 33 && ev.message_type === xintent.atoms.XINTENT_INTENT_V0) {
      const { payload, channel } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
      if (payload.intent === 'media.StreamJob') {
        activeChannel = channel;
        liveStatusBlob = await xintent.XBlobCreate(X, xintent.routerWin, serviceWin, {
          type: 'application/json',
          data: JSON.stringify({ status: 'streaming', version: 1 }),
          _dataType: 'text',
        });

        await xintent.sendXIntentEventV0(X, xintent.routerWin, {
          senderWin: serviceWin,
          channel: activeChannel,
          controlWord: 0, // Keep channel open!
          payload: {
            event: 'ui.Progress',
            progress: 10,
            phase: 'pre-migration',
            liveStatusBlob: xintent.widString(liveStatusBlob),
          },
        });
      }
    }
  });

  return {
    X,
    serviceWin,
    getActiveChannel: () => activeChannel,
    getLiveStatusBlob: () => liveStatusBlob,
    sendInFlightCorkedEvents: async () => {
      await xintent.sendXIntentEventV0(X, xintent.routerWin, {
        senderWin: serviceWin,
        channel: activeChannel,
        controlWord: 0,
        payload: {
          event: 'ui.Progress',
          progress: 50,
          phase: 'during-cork',
        },
      });
      await xintent.XBlobBroadcast(X, xintent.routerWin, serviceWin, liveStatusBlob, 0, 2);
    },
    sendPostMigrationEvents: async () => {
      await xintent.XBlobBroadcast(X, xintent.routerWin, serviceWin, liveStatusBlob, 0, 3);
      await xintent.sendXIntentEventV0(X, xintent.routerWin, {
        senderWin: serviceWin,
        channel: activeChannel,
        controlWord: 2, // FIN
        payload: {
          event: 'ui.Progress',
          progress: 100,
          phase: 'post-migration',
          disposition: 'final',
        },
      });
    },
  };
}

async function cleanup() {
  if (globalTimeoutTimer) clearTimeout(globalTimeoutTimer);
  if (lighterProc) {
    try { lighterProc.kill('SIGTERM'); } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
    try { lighterProc.kill('SIGKILL'); } catch (_) {}
  }
  if (xvfbProc) {
    try { xvfbProc.kill('SIGKILL'); } catch (_) {}
  }
  try {
    execSync(`pkill -9 -f "xhtml-ff-" 2>/dev/null || true`);
    execSync(`rm -rf /tmp/xhtml-ff-* 2>/dev/null || true`);
    execSync(`fuser -k ${HTTP_PORT}/tcp 2>/dev/null || true`);
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 200));
}

async function runTest() {
  console.log('=== Starting xhtml.LiveMigrate E2E Test ===');
  process.env.PORT = String(HTTP_PORT);
  process.env.XINTENT_PORT = String(HTTP_PORT);

  try {
    execSync(`fuser -k ${HTTP_PORT}/tcp 2>/dev/null || true`);
  } catch (_) {}

  globalTimeoutTimer = setTimeout(async () => {
    console.error('\n!!! GLOBAL TEST TIMEOUT EXCEEDED !!!');
    await cleanup();
    process.exit(1);
  }, GLOBAL_TIMEOUT_MS);

  // 1. Ensure Xvfb is running
  if (process.env.USE_XVFB || !process.env.DISPLAY) {
    const displayNum = process.env.XVFB_DISPLAY || ':97';
    xvfbProc = spawn('Xvfb', [displayNum, '-screen', '0', '1280x1024x24'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 500));
    if (xvfbProc && !xvfbProc.killed) {
      process.env.DISPLAY = displayNum;
    }
  }
  if (!process.env.DISPLAY) process.env.DISPLAY = ':0';
  console.log(`[Step 1] Using DISPLAY=${process.env.DISPLAY}`);

  // 2. Spawn cool-service-lighter (starts xbus-daemon & cool-http-bridge)
  const lighterScript = path.join(__dirname, '..', 'cool-service-lighter', 'index.js');
  lighterProc = spawn('bun', [lighterScript], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(HTTP_PORT), XHTML_HEADLESS: '1' },
    stdio: 'ignore',
  });

  await pollHttpReady();
  console.log(`[Step 2] cool-http-bridge ready on port ${HTTP_PORT}`);

  // 3. Start mock streaming service on X11
  const mockService = await startMockStreamService();
  await new Promise((r) => setTimeout(r, 400));
  console.log(`[Step 3] mock-stream-service online on ${xintent.widString(mockService.serviceWin)}`);

  // 4. Allocate phone card proxy window (oldCardWin) via POST /api/card-session
  const sessionRes = await httpRequest('POST', '/api/card-session', {}, {
    appId: 'org.xintent.cool-ebook',
    cardId: 'phone-reader-1',
  });
  assert.strictEqual(sessionRes.statusCode, 200);
  const { cardWin: oldCardWin } = JSON.parse(sessionRes.body);
  assert(oldCardWin && oldCardWin.startsWith('0x'), 'Should return valid hex oldCardWin');
  console.log(`[Step 4] Allocated dedicated phone card proxy window oldCardWin=${oldCardWin}`);

  // 5. Upload a hard-linked XBlob owned by oldCardWin
  const bookPayload = 'Chapter 3: The Secret of the X11 Bus - Live Migration Edition';
  const createBlobRes = await httpRequest(
    'POST',
    '/xblob/XBlobCreate',
    {
      'Content-Type': 'text/plain',
      'X-Card-Window': oldCardWin,
      'X-Blob-Name': 'chapter3.txt',
    },
    Buffer.from(bookPayload, 'utf8')
  );
  assert.strictEqual(createBlobRes.statusCode, 200);
  const { blobId: bookBlobId } = JSON.parse(createBlobRes.body);
  assert(bookBlobId, 'Should create book XBlob linked to oldCardWin');
  console.log(`[Step 5] Created book XBlob ${bookBlobId} linked to oldCardWin=${oldCardWin}`);

  // 6. Open a long-lived streaming XChannel (txId = 42, SYN) from oldCardWin to mock-stream-service
  const streamTxId = 42;
  let initialProgressFrame = null;
  let phoneStreamReq = null;

  await new Promise((resolve, reject) => {
    const url = new URL('/intent/media/StreamJob', HTTP_BASE_URL);
    const bodyStr = JSON.stringify({ intent: 'media.StreamJob', app: 'mock-stream-service' });
    phoneStreamReq = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'multipart/mixed',
          'X-Card-Window': oldCardWin,
          'X-Tx-Id': String(streamTxId),
          'X-Channel-Control': 'SYN',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        res.on('data', (chunk) => {
          const parsedFrames = parseMultipartFrames(chunk.toString('utf8'));
          for (const f of parsedFrames) {
            if (f.event === 'ui.Progress' && f.phase === 'pre-migration') {
              initialProgressFrame = f;
              resolve();
            }
          }
        });
      }
    );
    phoneStreamReq.on('error', () => {});
    phoneStreamReq.write(bodyStr);
    phoneStreamReq.end();
    setTimeout(() => reject(new Error('Timed out waiting for pre-migration ui.Progress')), 8000);
  });

  assert(initialProgressFrame, 'Should receive initial pre-migration ui.Progress on txId=42');
  const liveStatusBlobId = initialProgressFrame.liveStatusBlob;
  assert(liveStatusBlobId, 'Initial progress frame should include liveStatusBlob');
  console.log(`[Step 6] Opened streaming XChannel txId=${streamTxId} from oldCardWin=${oldCardWin}; received pre-migration progress & liveStatusBlob=${liveStatusBlobId}`);

  // 7. Soft-link oldCardWin to liveStatusBlobId so oldCardWin subscribes to XBLOB_BROADCAST_V0
  const softLinkRes = await httpRequest(
    'POST',
    '/xblob/XBlobSoftLink',
    { 'X-Card-Window': oldCardWin },
    { blobId: liveStatusBlobId, targetWin: oldCardWin }
  );
  assert.strictEqual(softLinkRes.statusCode, 200);
  console.log(`[Step 7] Soft-linked oldCardWin=${oldCardWin} to liveStatusBlob=${liveStatusBlobId}`);

  // 8. Cork oldCardWin, emit in-flight XChannel frame + XBlobBroadcast while corked, and invoke xhtml.LiveMigrate
  const oldCardWinNum = parseInt(oldCardWin, 16);
  await xintent.XHtmlCorkWindow(mockService.X, xintent.routerWin, mockService.serviceWin, oldCardWinNum);
  await new Promise((r) => setTimeout(r, 50));

  // Emit in-flight events WHILE oldCardWin is corked!
  await mockService.sendInFlightCorkedEvents();
  console.log(`[Step 8] Corked oldCardWin=${oldCardWin} and emitted in-flight ui.Progress(50%) + XBlobBroadcast(v2)`);

  // Create migration state snapshot blob
  const expectedMigratedInput = '{"intent":"ui.Paste","migratedFromPhone":true}';
  const snapshotPayload = {
    version: 1,
    cardApp: 'intent-test-card',
    cardId: 'index',
    cardEntry: 'index.html',
    oldCardWin,
    localStorage: {
      'ebook.currentChapter': '3',
      'ebook.scrollOffset': '420',
    },
    domState: {
      scroll: { x: 0, y: 420 },
      inputs: {
        '#payload-input': expectedMigratedInput,
      },
    },
    customState: {
      readingProgress: 0.42,
      activeBookBlob: bookBlobId,
    },
    heldBlobs: [bookBlobId],
    softLinkedBlobs: [liveStatusBlobId],
    openChannels: [{ txId: streamTxId, intent: 'media.StreamJob' }],
  };

  const snapBlobRes = await httpRequest(
    'POST',
    '/xblob/XBlobCreate',
    {
      'Content-Type': 'application/json',
      'X-Card-Window': oldCardWin,
    },
    Buffer.from(JSON.stringify(snapshotPayload), 'utf8')
  );
  assert.strictEqual(snapBlobRes.statusCode, 200);
  const { blobId: stateBlobId } = JSON.parse(snapBlobRes.body);

  console.log(`[Step 9] Dispatching xhtml.LiveMigrate to user-laptop:cool-xhtml-runtime (stateBlob=${stateBlobId})...`);
  const migrateRes = await httpRequest(
    'POST',
    '/intent/xhtml/LiveMigrate',
    {
      Accept: 'multipart/mixed',
      'X-Card-Window': oldCardWin,
      'X-Channel-Control': 'SYN',
      'X-Attached-Blob-Id': stateBlobId,
    },
    {
      intent: 'xhtml.LiveMigrate',
      app: 'user-laptop:cool-xhtml-runtime',
      cardApp: 'intent-test-card',
      cardId: 'index',
      cardEntry: 'index.html',
      oldCardWin,
    }
  );
  assert.strictEqual(migrateRes.statusCode, 200);
  const migrateFrames = parseMultipartFrames(migrateRes.body);
  const migrateReply = migrateFrames.find((f) => f.event === 'xhtml.LiveMigrateResponse') || migrateFrames[0];
  assert(migrateReply, 'Should receive xhtml.LiveMigrateResponse');
  assert.strictEqual(migrateReply.status, 'ok', 'xhtml.LiveMigrateResponse status should be ok');
  const newCardWin = migrateReply.newCardWin;
  assert(newCardWin && newCardWin.startsWith('0x') && newCardWin !== oldCardWin, 'Should allocate a new dedicated newCardWin');
  console.log(`[Step 9] xhtml.LiveMigrateResponse succeeded! oldCardWin=${oldCardWin} -> newCardWin=${newCardWin}`);

  // 10. Destroy oldCardWin (simulating Flammenwerfer closing the migrated card on user-phone)
  if (phoneStreamReq) {
    try { phoneStreamReq.destroy(); } catch (_) {}
  }
  const destroyOldRes = await httpRequest('DELETE', `/api/card-session/${oldCardWin}`);
  assert.strictEqual(destroyOldRes.statusCode, 200);
  await new Promise((r) => setTimeout(r, 150));
  console.log(`[Step 10] Destroyed oldCardWin=${oldCardWin} on phone`);

  // 11. Verify bookBlobId survived oldCardWin destruction because its hard link was transferred to newCardWin!
  const readBookRes = await httpRequest('GET', `/blobs/${bookBlobId}`, {
    'X-Card-Window': newCardWin,
  });
  assert.strictEqual(readBookRes.statusCode, 200, 'Migrated book XBlob must remain alive after oldCardWin is destroyed');
  assert(
    readBookRes.body.includes(bookPayload),
    `Migrated book XBlob content should match original payload, got: ${readBookRes.body}`
  );
  console.log(`[Step 11] Verified XBlob ${bookBlobId} grant was atomically transferred to newCardWin=${newCardWin} and survived oldCardWin destruction!`);

  // 12. Attach WebSocket to newCardWin and verify both corked in-flight events AND post-migration live events arrive on txId=42!
  const receivedProgressPhases = new Set();
  const receivedBroadcastVersions = new Set();

  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${HTTP_PORT}/ws?cardWin=${encodeURIComponent(newCardWin)}&reattachTxIds=${streamTxId}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(
        new Error(
          `Timed out waiting for migrated channel/blob events on newCardWin. Progress phases: [${Array.from(receivedProgressPhases)}], Broadcast versions: [${Array.from(receivedBroadcastVersions)}]`
        )
      );
    }, 10000);

    ws.on('open', async () => {
      // Wait briefly for buffered corked events to replay, then trigger post-migration events from mock-stream-service
      setTimeout(async () => {
        await mockService.sendPostMigrationEvents();
      }, 150);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.event === 'ui.Progress' && Number(msg.txId) === streamTxId) {
          receivedProgressPhases.add(msg.phase);
          console.log(`  -> [newCardWin WebSocket] Received ui.Progress (${msg.progress}%, phase=${msg.phase}) on original txId=${msg.txId}`);
        } else if (msg.event === 'XBLOB_BROADCAST_V0') {
          receivedBroadcastVersions.add(Number(msg.version));
          console.log(`  -> [newCardWin WebSocket] Received XBLOB_BROADCAST_V0 (version=${msg.version}) for soft-linked blob ${msg.blobId}`);
        }

        if (
          receivedProgressPhases.has('during-cork') &&
          receivedProgressPhases.has('post-migration') &&
          receivedBroadcastVersions.has(2) &&
          receivedBroadcastVersions.has(3)
        ) {
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch (_) {}
    });
  });

  console.log('[Step 12] Verified both corked in-flight and post-migration XChannel frames (txId=42) and XBlobBroadcast events (v2, v3) arrived at newCardWin!');

  // 13. Wait for the headless Firefox browser launched by cool-xhtml-runtime in Xvfb to load the card & hydrate DOM + localStorage
  console.log(`[Step 13] Waiting for headless Firefox in Xvfb to load /apps/intent-test-card/index?cardWin=${newCardWin}&hydrateBlob=${stateBlobId} and hydrate state...`);
  let hydratedReport = null;
  const pollStart = Date.now();
  while (Date.now() - pollStart < 15000) {
    const dbgRes = await httpRequest('GET', '/api/debug/xaudio');
    if (dbgRes.statusCode === 200) {
      const dbg = JSON.parse(dbgRes.body);
      const cardInfo = (dbg.cardWindows || []).find((c) => c.widHex === newCardWin);
      if (cardInfo && cardInfo.hydratedReport) {
        hydratedReport = cardInfo.hydratedReport;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  assert(hydratedReport, 'Firefox should load the migrated card page and post /api/card-hydrated');
  assert(
    hydratedReport.userAgent && hydratedReport.userAgent.includes('Firefox'),
    `Expected Firefox User-Agent in hydratedReport, got: ${hydratedReport.userAgent}`
  );
  assert.strictEqual(
    hydratedReport.localStorage?.['ebook.currentChapter'],
    '3',
    'Firefox hydrated localStorage should contain ebook.currentChapter=3'
  );
  assert.strictEqual(
    hydratedReport.domInputs?.['#payload-input'],
    expectedMigratedInput,
    'Firefox hydrated DOM #payload-input should match phone snapshot value'
  );
  assert(
    Array.isArray(hydratedReport.heldBlobs) && hydratedReport.heldBlobs.includes(bookBlobId),
    'Firefox hydrated window.xhtml.heldBlobs should include migrated bookBlobId'
  );
  assert(
    Array.isArray(hydratedReport.softLinkedBlobs) && hydratedReport.softLinkedBlobs.includes(liveStatusBlobId),
    'Firefox hydrated window.xhtml.softLinkedBlobs should include migrated liveStatusBlobId'
  );
  console.log(`[Step 13] Verified real Firefox browser (${hydratedReport.userAgent}) loaded card ${newCardWin} in Xvfb and hydrated localStorage, DOM (#payload-input), heldBlobs, and softLinkedBlobs!`);

  console.log('\n=======================================================');
  console.log('=== xhtml.LiveMigrate E2E TEST PASSED COMPLETELY!   ===');
  console.log('=======================================================\n');
}

runTest()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n!!! xhtml.LiveMigrate E2E TEST FAILED !!!\n', err);
    await cleanup();
    process.exit(1);
  });
