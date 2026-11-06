// test_atd_espresso_live_migrate.js - End-to-End 3-Hop Live Migration Test
// user-laptop (Xvfb :98 Firefox) -> user-desktop (Xvfb :99 Firefox) -> user-phone:flammenwerfer (Android ATD Emulator + Espresso Web)
const assert = require('assert');
const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');

const HTTP_PORT = parseInt(process.env.PORT || process.env.XINTENT_PORT || '12358', 10);
const HTTP_BASE_URL = `http://localhost:${HTTP_PORT}`;
const LAPTOP_DISPLAY = process.env.LAPTOP_XVFB_DISPLAY || ':98';
const DESKTOP_DISPLAY = process.env.DESKTOP_XVFB_DISPLAY || ':99';
const ADB_BIN = '/home/user/Android/Sdk/platform-tools/adb';
const EMULATOR_BIN = '/home/user/Android/Sdk/emulator/emulator';
const ATD_AVD_NAME = process.env.ATD_AVD_NAME || 'flammenwerfer_atd';
const GLOBAL_TIMEOUT_MS = 120000;

let xvfbLaptopProc = null;
let xvfbDesktopProc = null;
let lighterProc = null;
let desktopRuntimeProc = null;
let espressoProc = null;
let spawnedEmulatorProc = null;
let globalTimeoutTimer = null;

async function ensureAtdEmulatorOnline() {
  const devicesOut = execSync(`${ADB_BIN} devices`).toString('utf8');
  if (devicesOut.includes('emulator-')) {
    return;
  }
  console.log(`[Step 1] Booting headless ATD emulator (${ATD_AVD_NAME})...`);
  spawnedEmulatorProc = spawn(
    EMULATOR_BIN,
    ['-avd', ATD_AVD_NAME, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-gpu', 'swiftshader_indirect'],
    {
      env: { ...process.env, ANDROID_SDK_ROOT: '/home/user/Android/Sdk' },
      stdio: 'ignore',
    }
  );
  const startWait = Date.now();
  while (Date.now() - startWait < 60000) {
    try {
      const bootProp = execSync(`${ADB_BIN} shell getprop sys.boot_completed 2>/dev/null`).toString('utf8').trim();
      if (bootProp === '1') return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ATD emulator ${ATD_AVD_NAME} to finish booting`);
}

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
    25000
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

async function cleanup() {
  if (globalTimeoutTimer) clearTimeout(globalTimeoutTimer);
  for (const proc of [espressoProc, desktopRuntimeProc, lighterProc]) {
    if (proc) {
      try { proc.kill('SIGTERM'); } catch (_) {}
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  for (const proc of [espressoProc, desktopRuntimeProc, lighterProc, xvfbLaptopProc, xvfbDesktopProc, spawnedEmulatorProc]) {
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
  console.log('=== Starting 3-Hop Live Migration to Android ATD Emulator + Espresso Web Test ===');
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

  // 1. Verify ATD Android Emulator is online and configure adb reverse tunnel to cool-http-bridge
  await ensureAtdEmulatorOnline();
  execSync(`${ADB_BIN} reverse tcp:${HTTP_PORT} tcp:${HTTP_PORT}`);
  console.log(`[Step 1] Verified ATD Android emulator online and set up adb reverse tcp:${HTTP_PORT} -> tcp:${HTTP_PORT}`);

  // 2. Start two separate Xvfb displays: :98 for user-laptop and :99 for user-desktop
  xvfbLaptopProc = spawn('Xvfb', [LAPTOP_DISPLAY, '-screen', '0', '1280x1024x24'], { stdio: 'ignore' });
  xvfbDesktopProc = spawn('Xvfb', [DESKTOP_DISPLAY, '-screen', '0', '1280x1024x24'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  process.env.DISPLAY = LAPTOP_DISPLAY;
  console.log(`[Step 2] Started Xvfb servers: user-laptop=${LAPTOP_DISPLAY}, user-desktop=${DESKTOP_DISPLAY}`);

  // 3. Start cool-service-lighter (xbus-daemon, cool-http-bridge, cool-terminal, and user-laptop:cool-xhtml-runtime on :98)
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
  console.log(`[Step 3] cool-http-bridge & user-laptop:cool-xhtml-runtime (Xvfb ${LAPTOP_DISPLAY}) online on port ${HTTP_PORT}`);

  // 4. Start second desktop card runtime: user-desktop:cool-xhtml-runtime on Xvfb :99
  const runtimeScript = path.join(__dirname, '..', 'cool-xhtml-runtime', 'index.js');
  desktopRuntimeProc = spawn(
    'bun',
    [runtimeScript, '--host', 'user-desktop', '--display', DESKTOP_DISPLAY, '--webdriver'],
    {
      cwd: path.join(__dirname, '..', 'cool-xhtml-runtime'),
      env: {
        ...process.env,
        DISPLAY: LAPTOP_DISPLAY,
        XINTENT_HOST: 'user-desktop',
        XHTML_DISPLAY: DESKTOP_DISPLAY,
        XHTML_WEBDRIVER: '1',
        PORT: String(HTTP_PORT),
      },
      stdio: process.env.DEBUG_LOGS ? 'inherit' : 'ignore',
    }
  );

  // 5. Launch Flammenwerfer's LiveMigrateEspressoWebTest on the ATD emulator via adb shell am instrument
  let espressoOutput = '';
  const espressoDonePromise = new Promise((resolve, reject) => {
    espressoProc = spawn(
      ADB_BIN,
      [
        'shell',
        'am',
        'instrument',
        '-w',
        '-r',
        '-e',
        'class',
        'org.xintent.flammenwerfer.LiveMigrateEspressoWebTest#receiveMigratedCoolTerminalAndInteractViaEspressoWeb',
        '-e',
        'serverUrl',
        `http://127.0.0.1:${HTTP_PORT}`,
        '-e',
        'hostname',
        'user-phone',
        'org.xintent.flammenwerfer.test/androidx.test.runner.AndroidJUnitRunner',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    espressoProc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      espressoOutput += text;
      if (process.env.DEBUG_LOGS) process.stdout.write(`[ATD Espresso] ${text}`);
    });
    espressoProc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      espressoOutput += text;
      if (process.env.DEBUG_LOGS) process.stderr.write(`[ATD Espresso ERR] ${text}`);
    });
    espressoProc.on('close', (code) => {
      resolve({ code, output: espressoOutput });
    });
    espressoProc.on('error', reject);
  });

  // 6. Wait for user-laptop:cool-xhtml-runtime, user-desktop:cool-xhtml-runtime, AND user-phone:flammenwerfer (on ATD!) to appear in /api/tags
  let tagsReady = false;
  const tagsStart = Date.now();
  while (Date.now() - tagsStart < 20000) {
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
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(
    tagsReady,
    'Expected user-laptop:cool-xhtml-runtime, user-desktop:cool-xhtml-runtime, and ATD user-phone:flammenwerfer to register in /api/tags'
  );
  console.log('[Step 6] Verified ATD Flammenwerfer connected over WebSocket and registered user-phone:flammenwerfer on the XIntent bus!');

  // 7. Load cool-terminal on user-laptop:cool-xhtml-runtime (Xvfb :98 + WebDriver Firefox)
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
  console.log(`[Step 7] Loaded cool-terminal on user-laptop (${LAPTOP_DISPLAY}): cardWin=${laptopCardWin}`);

  // 8. Wait for cool-terminal on user-laptop (:98) to connect to PTY and execute 1st command
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
        return { screen, tty, blobs };
        `
      );
      if (info && info.screen.includes('Connected to /dev/pts/') && info.blobs.length >= 2) {
        laptopTermInfo = info;
        break;
      }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  assert(laptopTermInfo, 'cool-terminal on user-laptop should connect to PTY');

  await webdriverExec(
    laptopWdUrl,
    laptopWdSession,
    `
    const input = document.getElementById('cmd-input');
    input.value = 'export MIGRATE_SECRET=4242; echo "LAPTOP_PTY_OK:$MIGRATE_SECRET"';
    document.getElementById('send-btn').click();
    `
  );

  let laptopScreen = '';
  const cmdPollStart = Date.now();
  while (Date.now() - cmdPollStart < 10000) {
    laptopScreen = await webdriverExec(
      laptopWdUrl,
      laptopWdSession,
      `return document.getElementById('terminal-screen')?.textContent || '';`
    );
    if (laptopScreen.includes('LAPTOP_PTY_OK:4242')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(laptopScreen.includes('LAPTOP_PTY_OK:4242'), 'Expected LAPTOP_PTY_OK:4242 on user-laptop');
  console.log('[Step 8] Executed 1st command on user-laptop (:98) -> "LAPTOP_PTY_OK:4242"');

  // 9. Hop 1: Live-migrate cool-terminal from user-laptop (:98) -> user-desktop (:99)
  const migrateToDesktop = await webdriverExecAsync(
    laptopWdUrl,
    laptopWdSession,
    `
    const done = arguments[arguments.length - 1];
    window.xhtml.liveMigrate('user-desktop:cool-xhtml-runtime')
      .then((res) => done({ ok: true, res }))
      .catch((err) => done({ ok: false, error: err.message }));
    `
  );
  assert(migrateToDesktop && migrateToDesktop.ok, `1st liveMigrate failed: ${JSON.stringify(migrateToDesktop)}`);
  const desktopCardWin = migrateToDesktop.res.remoteWin || migrateToDesktop.res.newCardWin;
  console.log(`[Step 9] Hop 1 liveMigrate succeeded: ${laptopCardWin} (user-laptop :98) -> ${desktopCardWin} (user-desktop :99)`);

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
  assert(desktopCardInfo, 'user-desktop should open WebDriver Firefox on :99 and hydrate desktopCardWin');

  // 10. Execute 2nd command on user-desktop (:99) and verify output
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
    if (desktopScreenAfter.includes('DESKTOP_PTY_AFTER:5000')) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert(desktopScreenAfter.includes('DESKTOP_PTY_AFTER:5000'), 'Expected DESKTOP_PTY_AFTER:5000 on user-desktop');
  console.log('[Step 10] Executed 2nd command on user-desktop (:99) -> "DESKTOP_PTY_AFTER:5000"');

  // 11. Hop 2: Select "user-phone" in #xhtml-migrate-host-select on user-desktop (:99) and live-migrate to Flammenwerfer on the ATD emulator!
  const migrateToAtd = await webdriverExecAsync(
    desktopCardInfo.webdriverUrl,
    desktopCardInfo.webdriverSessionId,
    `
    const done = arguments[arguments.length - 1];
    (async () => {
      await window.xhtml.refreshRuntimeMigrateBar();
      const selectEl = document.getElementById('xhtml-migrate-host-select');
      const inputEl = document.getElementById('xhtml-migrate-host-input');
      const options = selectEl ? Array.from(selectEl.options).map((o) => o.value) : [];
      if (selectEl && options.includes('user-phone')) {
        selectEl.value = 'user-phone';
        selectEl.dispatchEvent(new Event('change'));
      } else if (inputEl) {
        inputEl.value = 'user-phone';
      }
      const res = await window.xhtml.liveMigrate('user-phone:cool-xhtml-runtime');
      done({ ok: true, options, res });
    })().catch((err) => done({ ok: false, error: err.message }));
    `
  );
  assert(migrateToAtd && migrateToAtd.ok, `2nd liveMigrate to ATD Flammenwerfer failed: ${JSON.stringify(migrateToAtd)}`);
  const atdCardWin = migrateToAtd.res.remoteWin || migrateToAtd.res.newCardWin;
  console.log(
    `[Step 11] Hop 2 liveMigrate to ATD Flammenwerfer succeeded: ${desktopCardWin} (user-desktop :99) -> ${atdCardWin} (ATD user-phone:flammenwerfer)`
  );
  console.log(`  -> 2nd-hop Transferred & NATted blobs: ${JSON.stringify(migrateToAtd.res.transferredBlobs)}`);

  // 12. Wait for Espresso Web on the ATD emulator to finish interacting with the migrated card and asserting PTY output!
  console.log('[Step 12] Waiting for Espresso Web on ATD emulator to verify DOM, NAT badges, type command, and assert PTY output...');
  const espressoResult = await espressoDonePromise;
  console.log(`[Step 12] ATD Espresso Web instrumentation output:\n${espressoResult.output.trim()}`);
  assert(
    espressoResult.output.includes('OK (1 test)'),
    `Expected Espresso Web instrumentation on ATD emulator to pass with 'OK (1 test)', got:\n${espressoResult.output}`
  );
  console.log('[Step 12] Verified Espresso Web on ATD emulator interacted with migrated cool-terminal card and confirmed "ATD_ESPRESSO_WEB_OK:5822"!');

  console.log('\n====================================================================================================');
  console.log('=== 3-Hop Live Migration (user-laptop -> user-desktop -> ATD Flammenwerfer + Espresso Web) PASSED! ===');
  console.log('====================================================================================================\n');
}

runTest()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\n!!! ATD + Espresso Web 3-Hop Live Migration TEST FAILED !!!\n', err);
    await cleanup();
    process.exit(1);
  });
