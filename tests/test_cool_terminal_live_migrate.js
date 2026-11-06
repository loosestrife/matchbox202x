// test_cool_terminal_live_migrate.js - End-to-End Test for Live Migrating cool-terminal
// from user-laptop:cool-xhtml-runtime (Xvfb :98 + WebDriver Firefox)
// -> user-desktop:cool-xhtml-runtime (Xvfb :99 + WebDriver Firefox)
// -> user-phone:flammenwerfer (WebSocket + Xvfb :100 WebDriver Firefox WebView)
const assert = require('assert');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const HTTP_PORT = parseInt(process.env.PORT || process.env.XINTENT_PORT || '12358', 10);
const HTTP_BASE_URL = `http://localhost:${HTTP_PORT}`;
const LAPTOP_DISPLAY = process.env.LAPTOP_XVFB_DISPLAY || ':98';
const DESKTOP_DISPLAY = process.env.DESKTOP_XVFB_DISPLAY || ':99';
const PHONE_DISPLAY = process.env.PHONE_XVFB_DISPLAY || ':100';
const GLOBAL_TIMEOUT_MS = 90000;

let xvfbLaptopProc = null;
let xvfbDesktopProc = null;
let xvfbPhoneProc = null;
let lighterProc = null;
let desktopRuntimeProc = null;
let flammenwerferWs = null;
let flammenwerferGdProc = null;
let globalTimeoutTimer = null;

function httpRequest(method, urlStrOrPath, headers = {}, body = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = urlStrOrPath.startsWith('http')
      ? new URL(urlStrOrPath)
      : new URL(urlStrOrPath, HTTP_BASE_URL);
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
      req.destroy(new Error(`HTTP request ${method} ${url.href} timed out`));
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

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

async function webdriverExec(webdriverUrl, sessionId, script, args = []) {
  const res = await httpRequest(
    'POST',
    `${webdriverUrl}/session/${encodeURIComponent(sessionId)}/execute/sync`,
    {},
    { script, args }
  );
  if (res.statusCode !== 200) {
    throw new Error(`WebDriver execute/sync failed (${res.statusCode}): ${res.body}`);
  }
  const parsed = JSON.parse(res.body);
  return parsed.value;
}

async function webdriverExecAsync(webdriverUrl, sessionId, script, args = []) {
  const res = await httpRequest(
    'POST',
    `${webdriverUrl}/session/${encodeURIComponent(sessionId)}/execute/async`,
    {},
    { script, args },
    20000
  );
  if (res.statusCode !== 200) {
    throw new Error(`WebDriver execute/async failed (${res.statusCode}): ${res.body}`);
  }
  const parsed = JSON.parse(res.body);
  return parsed.value;
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

async function launchFlammenwerferWebViewBrowser(cardUrl, phoneCardWin, cardApp, cardId) {
  const geckodriverBin = fs.existsSync('/snap/firefox/current/usr/lib/firefox/geckodriver')
    ? '/snap/firefox/current/usr/lib/firefox/geckodriver'
    : fs.existsSync('/snap/bin/geckodriver')
      ? '/snap/bin/geckodriver'
      : 'geckodriver';
  const firefoxBinary = fs.existsSync('/usr/lib/firefox/firefox')
    ? '/usr/lib/firefox/firefox'
    : undefined;
  const gdPort = 15450;
  const webdriverUrl = `http://127.0.0.1:${gdPort}`;

  flammenwerferGdProc = spawn(geckodriverBin, ['--port', String(gdPort)], {
    detached: true,
    env: {
      ...process.env,
      DISPLAY: PHONE_DISPLAY,
      MOZ_DISABLE_CONTENT_SANDBOX: '1',
    },
    stdio: 'ignore',
  });
  flammenwerferGdProc.unref();

  for (let i = 0; i < 40; i++) {
    try {
      const statusRes = await httpRequest('GET', `${webdriverUrl}/status`, {}, null, 500);
      if (statusRes.statusCode === 200) break;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const ffOptions = {
    args: ['--no-remote', '-width', '1024', '-height', '768'],
    prefs: {
      'browser.shell.checkDefaultBrowser': false,
      'datareporting.policy.dataSubmissionPolicyBypassNotification': true,
      'browser.startup.homepage_override.mstone': 'ignore',
      'browser.tabs.warnOnClose': false,
      'toolkit.telemetry.reportingpolicy.firstRun': false,
      'trailhead.firstrun.didSeeAboutWelcome': true,
    },
  };
  if (firefoxBinary) {
    ffOptions.binary = firefoxBinary;
  }

  const createRes = await httpRequest(
    'POST',
    `${webdriverUrl}/session`,
    {},
    {
      capabilities: {
        alwaysMatch: {
          browserName: 'firefox',
          'moz:firefoxOptions': ffOptions,
        },
      },
    },
    15000
  );
  const parsedCreate = JSON.parse(createRes.body);
  const sessionId = parsedCreate?.value?.sessionId;
  assert(sessionId, `Flammenwerfer WebView WebDriver session creation failed: ${createRes.body}`);

  await httpRequest(
    'POST',
    `${webdriverUrl}/session/${encodeURIComponent(sessionId)}/url`,
    {},
    { url: cardUrl }
  );
  await httpRequest('POST', '/api/card-session', {}, {
    cardWin: phoneCardWin,
    appId: cardApp,
    cardId,
    runtimeHost: 'user-phone',
    browserDisplay: PHONE_DISPLAY,
    webdriverUrl,
    webdriverSessionId: sessionId,
  });
  return { webdriverUrl, webdriverSessionId: sessionId };
}

function connectFlammenwerferClient() {
  return new Promise((resolve, reject) => {
    const wsUrl = `ws://localhost:${HTTP_PORT}/xaudio?XAudioSink=user-phone:flammenwerfer`;
    const ws = new WebSocket(wsUrl, 'message-http');
    flammenwerferWs = ws;

    const flammenwerferManifest = `
[computer]
host = "user-phone"

[app]
id = "flammenwerfer"
name = "Flammenwerfer"
version = "1.0.0"

[intents]
"audio.Play" = true
"audio.Stop" = true
"xhtml.LoadCard" = true
"xhtml.LiveMigrate" = true
"sys.LiveMigrate" = true
`;

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          event: 'bridge.Advertise',
          app: 'user-phone:flammenwerfer',
          manifest: flammenwerferManifest.trim(),
        })
      );
      resolve(ws);
    });

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString('utf8'));
        const evName = msg.event || msg.intent;
        if (evName === 'sys.LiveMigrate' || evName === 'xhtml.LiveMigrate') {
          const cardApp = msg.cardApp || 'cool-terminal';
          const cardId = msg.cardId || 'index';
          const oldCardWin = msg.oldCardWin || msg.cardWin;
          const stateBlob = msg.stateBlob || msg.dataBlob;
          const txId = msg.txId || msg.channel || 1;

          // Mirrors XIntentDispatcher.handleWsLiveMigrateOrLoadCard in Flammenwerfer:
          // 1. Allocate newCardWin on cool-http-bridge via POST /api/card-session
          const sessionRes = await httpRequest('POST', '/api/card-session', {}, {
            appId: cardApp,
            cardId,
            runtimeHost: 'user-phone',
          });
          const sessionObj = JSON.parse(sessionRes.body);
          const phoneCardWin = sessionObj.cardWin;

          // 2. Build the card hydration URL (mirrors CardsWebViewSupport.buildCardUrl) and open in WebView (Xvfb :100 Firefox)
          const params = new URLSearchParams({
            cardWin: phoneCardWin,
            cardId,
          });
          if (stateBlob) {
            params.set('hydrateBlob', stateBlob);
          }
          const cardUrl = `${HTTP_BASE_URL}/apps/${cardApp}/${cardId}?${params.toString()}`;
          await launchFlammenwerferWebViewBrowser(cardUrl, phoneCardWin, cardApp, cardId);

          // 3. Reply with sys.LiveMigrateResponse over the WebSocket
          const replyEvent = `${evName}Response`;
          ws.send(
            JSON.stringify({
              event: replyEvent,
              intent: replyEvent,
              status: 'ok',
              host: 'user-phone',
              cardApp,
              cardId,
              oldCardWin,
              newCardWin: phoneCardWin,
              remoteWin: phoneCardWin,
              stateBlob,
              controlWord: 2,
              txId,
            })
          );
        }
      } catch (err) {
        console.error('[Flammenwerfer WS Error]', err);
      }
    });

    ws.on('error', reject);
  });
}

async function cleanup() {
  if (globalTimeoutTimer) clearTimeout(globalTimeoutTimer);
  if (flammenwerferWs) {
    try { flammenwerferWs.close(); } catch (_) {}
  }
  for (const proc of [desktopRuntimeProc, lighterProc]) {
    if (proc) {
      try { proc.kill('SIGTERM'); } catch (_) {}
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  for (const proc of [desktopRuntimeProc, lighterProc, flammenwerferGdProc, xvfbLaptopProc, xvfbDesktopProc, xvfbPhoneProc]) {
    if (proc) {
      try { proc.kill('SIGKILL'); } catch (_) {}
    }
  }
  try {
    execSync(`pkill -9 -f "geckodriver" 2>/dev/null || true`);
    execSync(`pkill -9 -f "xhtml-ff-" 2>/dev/null || true`);
    execSync(`rm -rf /tmp/xhtml-ff-* 2>/dev/null || true`);
    execSync(`fuser -k ${HTTP_PORT}/tcp 2>/dev/null || true`);
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 200));
}

async function runTest() {
  console.log('=== Starting Triple-Xvfb 3-Hop Live Migration Test (user-laptop -> user-desktop -> flammenwerfer) ===');
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

  // 1. Start three separate Xvfb displays: :98 for user-laptop, :99 for user-desktop, and :100 for user-phone (flammenwerfer)
  xvfbLaptopProc = spawn('Xvfb', [LAPTOP_DISPLAY, '-screen', '0', '1280x1024x24'], { stdio: 'ignore' });
  xvfbDesktopProc = spawn('Xvfb', [DESKTOP_DISPLAY, '-screen', '0', '1280x1024x24'], { stdio: 'ignore' });
  xvfbPhoneProc = spawn('Xvfb', [PHONE_DISPLAY, '-screen', '0', '1280x1024x24'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  process.env.DISPLAY = LAPTOP_DISPLAY;
  console.log(`[Step 1] Started three separate Xvfb servers: user-laptop=${LAPTOP_DISPLAY}, user-desktop=${DESKTOP_DISPLAY}, user-phone(flammenwerfer)=${PHONE_DISPLAY}`);

  // 2. Start cool-service-lighter (launches xbus-daemon, cool-http-bridge, cool-terminal, and user-laptop:cool-xhtml-runtime on :98)
  const lighterScript = path.join(__dirname, '..', 'cool-service-lighter', 'index.js');
  lighterProc = spawn('bun', [lighterScript], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DISPLAY: LAPTOP_DISPLAY,
      XINTENT_HOST: 'user-laptop',
      XHTML_DISPLAY: LAPTOP_DISPLAY,
      XHTML_WEBDRIVER: '1',
      PORT: String(HTTP_PORT),
    },
    stdio: process.env.DEBUG_LOGS ? 'inherit' : 'ignore',
  });

  await pollHttpReady();
  console.log(`[Step 2] cool-http-bridge & user-laptop:cool-xhtml-runtime (Xvfb ${LAPTOP_DISPLAY}) online on port ${HTTP_PORT}`);

  // 3. Start second card runtime: user-desktop:cool-xhtml-runtime rendering on Xvfb :99, and connect third runtime: user-phone:flammenwerfer (Xvfb :100)
  const runtimeScript = path.join(__dirname, '..', 'cool-xhtml-runtime', 'index.js');
  desktopRuntimeProc = spawn(
    'bun',
    [runtimeScript, '--host', 'user-desktop', '--display', DESKTOP_DISPLAY, '--webdriver'],
    {
      cwd: path.join(__dirname, '..', 'cool-xhtml-runtime'),
      env: {
        ...process.env,
        DISPLAY: LAPTOP_DISPLAY, // XIntent bus display
        XINTENT_HOST: 'user-desktop',
        XHTML_DISPLAY: DESKTOP_DISPLAY, // Dedicated Xvfb display :99 for user-desktop browser windows
        XHTML_WEBDRIVER: '1',
        PORT: String(HTTP_PORT),
      },
      stdio: process.env.DEBUG_LOGS ? 'inherit' : 'ignore',
    }
  );
  await connectFlammenwerferClient();

  // Wait for user-laptop:cool-xhtml-runtime, user-desktop:cool-xhtml-runtime, and user-phone:flammenwerfer to appear in /api/tags
  let tagsReady = false;
  const tagsStart = Date.now();
  while (Date.now() - tagsStart < 10000) {
    const tagsRes = await httpRequest('GET', '/api/tags');
    if (tagsRes.statusCode === 200) {
      const tags = JSON.parse(tagsRes.body);
      const liveMigrateProviders = tags?.intents?.['sys.LiveMigrate'] || [];
      if (
        liveMigrateProviders.includes('user-laptop:cool-xhtml-runtime') &&
        liveMigrateProviders.includes('user-desktop:cool-xhtml-runtime') &&
        liveMigrateProviders.includes('user-phone:flammenwerfer')
      ) {
        tagsReady = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(tagsReady, 'user-laptop:cool-xhtml-runtime, user-desktop:cool-xhtml-runtime, and user-phone:flammenwerfer should register on the bus');
  console.log(`[Step 3] Verified all 3 runtimes registered on bus: user-laptop (${LAPTOP_DISPLAY}), user-desktop (${DESKTOP_DISPLAY}), & user-phone:flammenwerfer (${PHONE_DISPLAY})`);

  // 4. Load cool-terminal on user-laptop:cool-xhtml-runtime (Xvfb :98 + WebDriver Firefox)
  const loadRes = await httpRequest(
    'POST',
    '/intent/xhtml/LoadCard?app=user-laptop:cool-xhtml-runtime',
    {
      Accept: 'multipart/mixed',
      'X-Channel-Control': 'SYN',
    },
    {
      intent: 'xhtml.LoadCard',
      app: 'user-laptop:cool-xhtml-runtime',
      cardApp: 'cool-terminal',
      cardId: 'index',
    }
  );
  assert.strictEqual(loadRes.statusCode, 200);
  const loadFrames = parseMultipartFrames(loadRes.body);
  const loadReply = loadFrames.find((f) => f.event === 'xhtml.LoadCardResponse') || loadFrames[0];
  assert(loadReply && loadReply.status === 'ok', 'xhtml.LoadCard should succeed on user-laptop:cool-xhtml-runtime');
  const laptopCardWin = loadReply.cardWin;
  const laptopWdUrl = loadReply.webdriverUrl;
  const laptopWdSession = loadReply.webdriverSessionId;
  assert(laptopCardWin && laptopWdUrl && laptopWdSession, 'Should return laptopCardWin and WebDriver session info');
  assert.strictEqual(loadReply.display, LAPTOP_DISPLAY, 'user-laptop card should run on LAPTOP_DISPLAY');
  console.log(`[Step 4] Loaded cool-terminal on user-laptop (${LAPTOP_DISPLAY}): cardWin=${laptopCardWin}, WebDriver session=${laptopWdSession}`);

  // 5. Wait for cool-terminal in user-laptop's Firefox on Xvfb :98 to connect to PTY
  let laptopTermInfo = null;
  const termPollStart = Date.now();
  while (Date.now() - termPollStart < 12000) {
    try {
      const info = await webdriverExec(
        laptopWdUrl,
        laptopWdSession,
        `
        const screen = document.getElementById('terminal-screen')?.textContent || '';
        const tty = document.getElementById('tty-badge')?.textContent || '';
        const blobs = Array.from(window.xhtml?.heldBlobs || []);
        return { screen, tty, blobs, cardWin: window.xhtml?.cardWin };
        `
      );
      if (info && info.screen.includes('Connected to /dev/pts/') && info.blobs.length >= 2) {
        laptopTermInfo = info;
        break;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(laptopTermInfo, 'cool-terminal on user-laptop should connect to PTY and render on #terminal-screen');
  console.log(`[Step 5] Verified cool-terminal PTY connected on user-laptop (${laptopTermInfo.tty}), heldBlobs=${JSON.stringify(laptopTermInfo.blobs)}`);

  // 6. Type a shell command on user-laptop via WebDriver and verify output on 80x24 screen
  await webdriverExec(
    laptopWdUrl,
    laptopWdSession,
    `
    const input = document.getElementById('cmd-input');
    input.value = 'export MIGRATE_SECRET=4242; echo "LAPTOP_PTY_OK:$MIGRATE_SECRET"';
    document.getElementById('send-btn').click();
    `
  );

  let laptopScreenBeforeMigrate = '';
  const cmdPollStart = Date.now();
  while (Date.now() - cmdPollStart < 10000) {
    laptopScreenBeforeMigrate = await webdriverExec(
      laptopWdUrl,
      laptopWdSession,
      `return document.getElementById('terminal-screen')?.textContent || '';`
    );
    if (laptopScreenBeforeMigrate.includes('LAPTOP_PTY_OK:4242')) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(
    laptopScreenBeforeMigrate.includes('LAPTOP_PTY_OK:4242'),
    `Expected LAPTOP_PTY_OK:4242 on user-laptop terminal screen, got:\n${laptopScreenBeforeMigrate}`
  );
  console.log('[Step 6] Verified command executed on user-laptop PTY and rendered "LAPTOP_PTY_OK:4242" on Xvfb :98');

  // 7. Verify universal #xhtml-runtime-migrate-bar UI (hostname select/input + Migrate button) and trigger 5-step live migration
  const migrateBarState = await webdriverExecAsync(
    laptopWdUrl,
    laptopWdSession,
    `
    const done = arguments[arguments.length - 1];
    (async () => {
      if (window.xhtml && typeof window.xhtml.refreshRuntimeMigrateBar === 'function') {
        await window.xhtml.refreshRuntimeMigrateBar();
      }
      const bar = document.getElementById('xhtml-runtime-migrate-bar');
      const selectEl = document.getElementById('xhtml-migrate-host-select');
      const inputEl = document.getElementById('xhtml-migrate-host-input');
      const btnEl = document.getElementById('xhtml-migrate-btn');
      const options = selectEl ? Array.from(selectEl.options).map((o) => o.value) : [];
      if (selectEl && options.includes('user-desktop')) {
        selectEl.value = 'user-desktop';
        selectEl.dispatchEvent(new Event('change'));
      } else if (inputEl) {
        inputEl.value = 'user-desktop';
      }
      done({
        hasBar: Boolean(bar && selectEl && inputEl && btnEl),
        options,
        selectedHost: inputEl?.value || selectEl?.value || '',
      });
    })();
    `
  );
  assert(migrateBarState && migrateBarState.hasBar, 'Expected #xhtml-runtime-migrate-bar with host select, input, and Migrate button on XHTML card');
  assert(
    migrateBarState.options.includes('user-desktop') && migrateBarState.options.includes('user-laptop'),
    `Expected #xhtml-migrate-host-select to list user-laptop and user-desktop, got: ${JSON.stringify(migrateBarState.options)}`
  );
  assert.strictEqual(migrateBarState.selectedHost, 'user-desktop', 'Expected selected target host to be user-desktop');
  console.log(`[Step 7] Verified universal XHTML Runtime Migrate Bar (options=${JSON.stringify(migrateBarState.options)}, selected="${migrateBarState.selectedHost}"); triggering liveMigrate...`);
  const migrateResult = await webdriverExecAsync(
    laptopWdUrl,
    laptopWdSession,
    `
    const done = arguments[arguments.length - 1];
    const rawHost = document.getElementById('xhtml-migrate-host-input')?.value || 'user-desktop';
    const targetRuntime = rawHost.includes(':') ? rawHost : rawHost + ':cool-xhtml-runtime';
    window.xhtml.liveMigrate(targetRuntime)
      .then((res) => done({ ok: true, res }))
      .catch((err) => done({ ok: false, error: err.message }));
    `
  );
  assert(migrateResult && migrateResult.ok, `liveMigrate failed: ${JSON.stringify(migrateResult)}`);
  const migRes = migrateResult.res;
  const desktopCardWin = migRes.remoteWin || migRes.newCardWin;
  assert(desktopCardWin && desktopCardWin !== laptopCardWin, 'Should allocate new desktopCardWin on user-desktop');
  assert(
    Array.isArray(migRes.transferredBlobs) && migRes.transferredBlobs.length >= 2,
    `Expected at least 2 transferred blobs (stdin & stdout pipes) in sys.LiveMigrateCommitResponse, got: ${JSON.stringify(migRes.transferredBlobs)}`
  );
  console.log(
    `[Step 7] 5-step liveMigrate succeeded! ${laptopCardWin} (user-laptop ${LAPTOP_DISPLAY}) -> ${desktopCardWin} (user-desktop ${DESKTOP_DISPLAY})`
  );
  console.log(`  -> Transferred & NATted blobs: ${JSON.stringify(migRes.transferredBlobs)}`);
  console.log(`  -> Redirected channels: ${JSON.stringify(migRes.migratedChannels)}`);

  // 8. Discover the new WebDriver Firefox session on user-desktop (Xvfb :99) for desktopCardWin
  let desktopCardInfo = null;
  const desktopPollStart = Date.now();
  while (Date.now() - desktopPollStart < 15000) {
    const dbgRes = await httpRequest('GET', '/api/debug/xaudio');
    if (dbgRes.statusCode === 200) {
      const dbg = JSON.parse(dbgRes.body);
      const found = (dbg.cardWindows || []).find(
        (c) => c.widHex === desktopCardWin && c.webdriverUrl && c.webdriverSessionId && c.hydratedReport
      );
      if (found) {
        desktopCardInfo = found;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(desktopCardInfo, 'user-desktop:cool-xhtml-runtime should launch WebDriver Firefox on Xvfb :99 and hydrate desktopCardWin');
  assert.strictEqual(desktopCardInfo.runtimeHost, 'user-desktop', 'Migrated card should be hosted on user-desktop');
  assert.strictEqual(desktopCardInfo.browserDisplay, DESKTOP_DISPLAY, 'Migrated card browser should run on DESKTOP_DISPLAY (:99)');
  console.log(
    `[Step 8] Verified user-desktop (${desktopCardInfo.browserDisplay}) opened WebDriver Firefox session=${desktopCardInfo.webdriverSessionId} for ${desktopCardWin}`
  );

  // 9. Inspect the migrated cool-terminal DOM and virtual private bus NAT table on user-desktop (Xvfb :99) via WebDriver
  const desktopState = await webdriverExecAsync(
    desktopCardInfo.webdriverUrl,
    desktopCardInfo.webdriverSessionId,
    `
    const done = arguments[arguments.length - 1];
    (async () => {
      const screen = document.getElementById('terminal-screen')?.textContent || '';
      const tty = document.getElementById('tty-badge')?.textContent || '';
      const inBlobBadge = document.getElementById('in-blob-badge')?.textContent || '';
      const outBlobBadge = document.getElementById('out-blob-badge')?.textContent || '';
      const blobBadge = document.getElementById('blob-badge')?.textContent || '';
      const heldBlobs = Array.from(window.xhtml?.heldBlobs || []);
      const natEntries = {};
      const remappedEntries = {};
      for (const b of heldBlobs) {
        natEntries[b] = window.xhtml.getNatInfo('blob', b);
        remappedEntries[b] = await window.xhtml.whenRemapped('blob', b);
      }
      done({
        screen,
        tty,
        inBlobBadge,
        outBlobBadge,
        blobBadge,
        heldBlobs,
        natEntries,
        remappedEntries,
      });
    })();
    `
  );

  assert(
    desktopState.screen.includes('LAPTOP_PTY_OK:4242'),
    `Migrated terminal screen on user-desktop (:99) should preserve pre-migration output "LAPTOP_PTY_OK:4242", got:\n${desktopState.screen}`
  );
  assert.strictEqual(
    desktopState.tty,
    laptopTermInfo.tty,
    'Migrated terminal on user-desktop should remain attached to the exact same PTY'
  );
  for (const origBlobId of laptopTermInfo.blobs) {
    const nattedId = desktopState.natEntries[origBlobId];
    assert(
      nattedId && nattedId !== origBlobId,
      `Expected virtual blob ${origBlobId} to be NATted to a new local blob ID on user-desktop, got ${nattedId}`
    );
    assert.strictEqual(
      desktopState.remappedEntries[origBlobId],
      nattedId,
      `window.xhtml.whenRemapped('blob', '${origBlobId}') should resolve to NATted blob ID ${nattedId}`
    );
    assert(
      desktopState.blobBadge.includes(origBlobId) && desktopState.blobBadge.includes(nattedId),
      `Expected #blob-badge UI to display both NATted blob ID (${origBlobId}) and actual bus blob ID (${nattedId}), got: ${desktopState.blobBadge}`
    );
  }
  console.log(`[Step 9] Verified pre-migration screen buffer & virtual private bus NAT on user-desktop (${DESKTOP_DISPLAY}):`);
  console.log(`  -> Virtual-to-Local Blob NAT table: ${JSON.stringify(desktopState.natEntries)}`);
  console.log(`  -> UI Badges: [${desktopState.inBlobBadge}] [${desktopState.outBlobBadge}]`);
  console.log(`  -> Combined Badge text: ${desktopState.blobBadge}`);

  // 10. Type a post-migration command in the user-desktop Firefox browser (:99) and verify the same bash PTY responds!
  await webdriverExec(
    desktopCardInfo.webdriverUrl,
    desktopCardInfo.webdriverSessionId,
    `
    const input = document.getElementById('cmd-input');
    input.value = 'echo "DESKTOP_PTY_AFTER:$((MIGRATE_SECRET + 758))"';
    document.getElementById('send-btn').click();
    `
  );

  let desktopScreenAfter = '';
  const postCmdStart = Date.now();
  while (Date.now() - postCmdStart < 10000) {
    desktopScreenAfter = await webdriverExec(
      desktopCardInfo.webdriverUrl,
      desktopCardInfo.webdriverSessionId,
      `return document.getElementById('terminal-screen')?.textContent || '';`
    );
    if (desktopScreenAfter.includes('DESKTOP_PTY_AFTER:5000')) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(
    desktopScreenAfter.includes('DESKTOP_PTY_AFTER:5000'),
    `Expected post-migration PTY output "DESKTOP_PTY_AFTER:5000" on user-desktop terminal screen, got:\n${desktopScreenAfter}`
  );
  console.log('[Step 10] Verified post-migration stdin/stdout streaming on user-desktop (:99): bash PTY evaluated $MIGRATE_SECRET+758 -> "DESKTOP_PTY_AFTER:5000"!');

  // 11. In user-desktop (:99), verify "user-phone" (Flammenwerfer) appears in #xhtml-migrate-host-select and trigger 2nd live migration -> user-phone:flammenwerfer
  const desktopMigrateBar = await webdriverExecAsync(
    desktopCardInfo.webdriverUrl,
    desktopCardInfo.webdriverSessionId,
    `
    const done = arguments[arguments.length - 1];
    (async () => {
      if (window.xhtml && typeof window.xhtml.refreshRuntimeMigrateBar === 'function') {
        await window.xhtml.refreshRuntimeMigrateBar();
      }
      const selectEl = document.getElementById('xhtml-migrate-host-select');
      const inputEl = document.getElementById('xhtml-migrate-host-input');
      const options = selectEl ? Array.from(selectEl.options).map((o) => o.value) : [];
      if (selectEl && options.includes('user-phone')) {
        selectEl.value = 'user-phone';
        selectEl.dispatchEvent(new Event('change'));
      } else if (inputEl) {
        inputEl.value = 'user-phone';
      }
      done({
        options,
        selectedHost: inputEl?.value || selectEl?.value || '',
      });
    })();
    `
  );
  assert(
    desktopMigrateBar && desktopMigrateBar.options.includes('user-phone'),
    `Expected #xhtml-migrate-host-select on user-desktop to list user-phone (Flammenwerfer), got: ${JSON.stringify(desktopMigrateBar?.options)}`
  );
  assert.strictEqual(desktopMigrateBar.selectedHost, 'user-phone', 'Expected selected target host on user-desktop to be user-phone');
  console.log(`[Step 11] Verified user-phone (Flammenwerfer) discovered in #xhtml-migrate-host-select (${JSON.stringify(desktopMigrateBar.options)}); triggering 2nd liveMigrate...`);

  const migrateToPhoneResult = await webdriverExecAsync(
    desktopCardInfo.webdriverUrl,
    desktopCardInfo.webdriverSessionId,
    `
    const done = arguments[arguments.length - 1];
    const rawHost = document.getElementById('xhtml-migrate-host-input')?.value || 'user-phone';
    const targetRuntime = rawHost.includes(':') ? rawHost : rawHost + ':cool-xhtml-runtime';
    window.xhtml.liveMigrate(targetRuntime)
      .then((res) => done({ ok: true, res }))
      .catch((err) => done({ ok: false, error: err.message }));
    `
  );
  assert(migrateToPhoneResult && migrateToPhoneResult.ok, `2nd liveMigrate to user-phone:flammenwerfer failed: ${JSON.stringify(migrateToPhoneResult)}`);
  const migPhoneRes = migrateToPhoneResult.res;
  const phoneCardWin = migPhoneRes.remoteWin || migPhoneRes.newCardWin;
  assert(
    phoneCardWin && phoneCardWin !== desktopCardWin && phoneCardWin !== laptopCardWin,
    'Should allocate new phoneCardWin on user-phone:flammenwerfer'
  );
  assert(
    Array.isArray(migPhoneRes.transferredBlobs) && migPhoneRes.transferredBlobs.length >= 2,
    `Expected at least 2 transferred blobs in 2nd-hop sys.LiveMigrateCommitResponse, got: ${JSON.stringify(migPhoneRes.transferredBlobs)}`
  );
  console.log(
    `[Step 11] 2nd-hop 5-step liveMigrate succeeded! ${desktopCardWin} (user-desktop ${DESKTOP_DISPLAY}) -> ${phoneCardWin} (user-phone:flammenwerfer ${PHONE_DISPLAY})`
  );
  console.log(`  -> 2nd-hop Transferred & NATted blobs: ${JSON.stringify(migPhoneRes.transferredBlobs)}`);

  // 12. Discover the Flammenwerfer WebView WebDriver session on user-phone (Xvfb :100) for phoneCardWin
  let phoneCardInfo = null;
  const phonePollStart = Date.now();
  while (Date.now() - phonePollStart < 15000) {
    const dbgRes = await httpRequest('GET', '/api/debug/xaudio');
    if (dbgRes.statusCode === 200) {
      const dbg = JSON.parse(dbgRes.body);
      const found = (dbg.cardWindows || []).find(
        (c) => c.widHex === phoneCardWin && c.webdriverUrl && c.webdriverSessionId && c.hydratedReport
      );
      if (found) {
        phoneCardInfo = found;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(phoneCardInfo, 'user-phone:flammenwerfer should open WebView browser on Xvfb :100 and hydrate phoneCardWin');
  assert.strictEqual(phoneCardInfo.runtimeHost, 'user-phone', '2nd-hop migrated card should be hosted on user-phone');
  assert.strictEqual(phoneCardInfo.browserDisplay, PHONE_DISPLAY, '2nd-hop migrated card should run on PHONE_DISPLAY (:100)');
  console.log(
    `[Step 12] Verified user-phone:flammenwerfer (${phoneCardInfo.browserDisplay}) opened WebView session=${phoneCardInfo.webdriverSessionId} for ${phoneCardWin}`
  );

  // 13. Inspect the 2nd-hop migrated cool-terminal DOM and virtual private bus NAT table on user-phone:flammenwerfer (Xvfb :100)
  const phoneState = await webdriverExecAsync(
    phoneCardInfo.webdriverUrl,
    phoneCardInfo.webdriverSessionId,
    `
    const done = arguments[arguments.length - 1];
    (async () => {
      const screen = document.getElementById('terminal-screen')?.textContent || '';
      const tty = document.getElementById('tty-badge')?.textContent || '';
      const inBlobBadge = document.getElementById('in-blob-badge')?.textContent || '';
      const outBlobBadge = document.getElementById('out-blob-badge')?.textContent || '';
      const blobBadge = document.getElementById('blob-badge')?.textContent || '';
      const heldBlobs = Array.from(window.xhtml?.heldBlobs || []);
      const natEntries = {};
      const remappedEntries = {};
      for (const b of heldBlobs) {
        natEntries[b] = window.xhtml.getNatInfo('blob', b);
        remappedEntries[b] = await window.xhtml.whenRemapped('blob', b);
      }
      done({
        screen,
        tty,
        inBlobBadge,
        outBlobBadge,
        blobBadge,
        heldBlobs,
        natEntries,
        remappedEntries,
      });
    })();
    `
  );

  assert(
    phoneState.screen.includes('LAPTOP_PTY_OK:4242') && phoneState.screen.includes('DESKTOP_PTY_AFTER:5000'),
    `Migrated terminal screen on user-phone:flammenwerfer (:100) should preserve both user-laptop ("LAPTOP_PTY_OK:4242") and user-desktop ("DESKTOP_PTY_AFTER:5000") output, got:\n${phoneState.screen}`
  );
  assert.strictEqual(
    phoneState.tty,
    laptopTermInfo.tty,
    'Migrated terminal on user-phone:flammenwerfer should remain attached to the exact same PTY'
  );
  for (const origBlobId of laptopTermInfo.blobs) {
    const desktopNattedId = desktopState.natEntries[origBlobId];
    const phoneNattedId = phoneState.natEntries[origBlobId];
    assert(
      phoneNattedId && phoneNattedId !== origBlobId && phoneNattedId !== desktopNattedId,
      `Expected virtual blob ${origBlobId} to be NATted to a brand new 2nd-hop bus blob ID on user-phone (was ${desktopNattedId} on desktop, got ${phoneNattedId})`
    );
    assert(
      phoneState.blobBadge.includes(origBlobId) && phoneState.blobBadge.includes(phoneNattedId),
      `Expected #blob-badge UI on user-phone to display both NATted blob ID (${origBlobId}) and actual 2nd-hop bus blob ID (${phoneNattedId}), got: ${phoneState.blobBadge}`
    );
  }
  console.log(`[Step 13] Verified 2nd-hop screen buffer & virtual private bus NAT on user-phone:flammenwerfer (${PHONE_DISPLAY}):`);
  console.log(`  -> Virtual-to-Local Blob NAT table (2nd hop): ${JSON.stringify(phoneState.natEntries)}`);
  console.log(`  -> UI Badges on Flammenwerfer: [${phoneState.inBlobBadge}] [${phoneState.outBlobBadge}]`);

  // 14. Type a 3rd shell command on user-phone:flammenwerfer (:100) and verify the same bash PTY responds!
  await webdriverExec(
    phoneCardInfo.webdriverUrl,
    phoneCardInfo.webdriverSessionId,
    `
    const input = document.getElementById('cmd-input');
    input.value = 'echo "FLAMMENWERFER_PTY_OK:$((MIGRATE_SECRET + 1580))"';
    document.getElementById('send-btn').click();
    `
  );

  let phoneScreenAfter = '';
  const phoneCmdStart = Date.now();
  while (Date.now() - phoneCmdStart < 10000) {
    phoneScreenAfter = await webdriverExec(
      phoneCardInfo.webdriverUrl,
      phoneCardInfo.webdriverSessionId,
      `return document.getElementById('terminal-screen')?.textContent || '';`
    );
    if (phoneScreenAfter.includes('FLAMMENWERFER_PTY_OK:5822')) {
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(
    phoneScreenAfter.includes('FLAMMENWERFER_PTY_OK:5822'),
    `Expected 2nd-hop post-migration PTY output "FLAMMENWERFER_PTY_OK:5822" on user-phone:flammenwerfer screen, got:\n${phoneScreenAfter}`
  );
  console.log('[Step 14] Verified 2nd-hop stdin/stdout streaming on user-phone:flammenwerfer (:100): bash PTY evaluated $MIGRATE_SECRET+1580 -> "FLAMMENWERFER_PTY_OK:5822"!');

  console.log('\n=========================================================================================');
  console.log('=== 3-Hop Live Migration (user-laptop -> user-desktop -> flammenwerfer) TEST PASSED! ===');
  console.log('=========================================================================================\n');
}

runTest()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n!!! Dual-Xvfb + WebDriver cool-terminal Live Migration TEST FAILED !!!\n', err);
    await cleanup();
    process.exit(1);
  });
