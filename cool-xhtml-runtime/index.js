#!/usr/bin/env bun
// cool-xhtml-runtime/index.js - Desktop XHTML Card Runtime & Live Migration Receiver
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');
const { Logger } = require('../server-tools');

const logger = new Logger({ module: 'cool-xhtml-runtime' });
logger.setProjectName('cool-xhtml-runtime');

const HTTP_PORT = parseInt(process.env.PORT || process.env.XINTENT_PORT || '12345', 10);
const HTTP_BASE_URL = `http://localhost:${HTTP_PORT}`;

function parseCliOption(flagNames) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    for (const flag of flagNames) {
      if (args[i] === flag && args[i + 1]) {
        return args[i + 1];
      }
      if (args[i].startsWith(`${flag}=`)) {
        return args[i].slice(`${flag}=`.length);
      }
    }
  }
  return null;
}

function hasCliFlag(flagNames) {
  const args = process.argv.slice(2);
  return args.some((a) => flagNames.some((f) => a === f || a.startsWith(`${f}=`)));
}

function resolveRuntimeHost() {
  return (
    parseCliOption(['--host', '-h']) ||
    process.env.XINTENT_HOST ||
    process.env.MATCHBOX_HOST ||
    os.hostname()
  );
}

function resolveBrowserDisplay() {
  return (
    parseCliOption(['--display', '--xhtml-display']) ||
    process.env.XHTML_DISPLAY ||
    process.env.DISPLAY ||
    ':0'
  );
}

function resolveWebDriverBasePort() {
  const portOpt =
    parseCliOption(['--webdriver-port']) ||
    process.env.XHTML_WEBDRIVER_PORT;
  if (portOpt) {
    const parsed = parseInt(portOpt, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  const dispMatch = String(resolveBrowserDisplay()).match(/:(\d+)/);
  const dispNum = dispMatch ? parseInt(dispMatch[1], 10) : 0;
  return 14400 + (dispNum % 500) * 10;
}

const RUNTIME_HOST = resolveRuntimeHost();
const BROWSER_DISPLAY = resolveBrowserDisplay();
const WEBDRIVER_ENABLED =
  hasCliFlag(['--webdriver', '--webdriver-port']) ||
  process.env.XHTML_WEBDRIVER === '1' ||
  process.env.XHTML_WEBDRIVER === 'true' ||
  Boolean(process.env.XHTML_WEBDRIVER_PORT);
let nextWebDriverPort = resolveWebDriverBasePort();

const MATCHBOX_TOML_MANIFEST = `
[computer]
host = "${RUNTIME_HOST}"

[app]
id = "cool-xhtml-runtime"
name = "Cool XHTML Runtime (${RUNTIME_HOST})"
description = "Desktop XHTML Card Runtime & Live Migration Receiver"

[app.main]
type = "html"
card = "index"

[[cards]]
id = "index"
path = "index.html"
title = "Cool XHTML Runtime — Web Card Launcher"

[intents."xhtml.LoadCard"]
invocation = "X11"

[intents."xhtml.LiveMigrate"]
invocation = "X11"

[intents."sys.LiveMigrate"]
invocation = "X11"

[intents."xhtml.MigrateCard"]
invocation = "X11"

[intents."sys.MigrateCard"]
invocation = "X11"

[intents."fs.Open"]
invocation = "X11"
`;

const activeCards = new Map(); // widHex -> cardSession
const tempProfileDirs = new Set();

function cleanupSpawnedBrowsers() {
  for (const session of activeCards.values()) {
    if (session.browserPid) {
      try { process.kill(session.browserPid, 'SIGKILL'); } catch (_) {}
    }
    const proc = session.browserProc;
    if (proc && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch (_) {
        try { proc.kill('SIGTERM'); } catch (_) {}
      }
    }
    const gdProc = session.gdProc;
    if (gdProc && gdProc.pid) {
      try {
        process.kill(-gdProc.pid, 'SIGKILL');
      } catch (_) {
        try { gdProc.kill('SIGKILL'); } catch (_) {}
      }
    }
  }
  for (const dir of tempProfileDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
  tempProfileDirs.clear();
}

process.on('SIGINT', () => {
  cleanupSpawnedBrowsers();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanupSpawnedBrowsers();
  process.exit(0);
});

function parseWindowId(raw) {
  if (!raw) return 0;
  if (typeof raw === 'number') return raw >>> 0;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const num = (trimmed.startsWith('0x') || trimmed.startsWith('0X'))
      ? parseInt(trimmed, 16)
      : Number(trimmed);
    return isNaN(num) ? 0 : (num >>> 0);
  }
  return 0;
}

function allocateBridgeCardSessionOnce(appId, cardId) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify({ appId, cardId });
    const req = http.request(
      `${HTTP_BASE_URL}/api/card-session`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: 2000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (parsed && parsed.wid) {
              return resolve(parsed);
            }
          } catch (_) {}
          resolve(null);
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(bodyStr);
    req.end();
  });
}

async function allocateBridgeCardSession(appId, cardId, maxWaitMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const session = await allocateBridgeCardSessionOnce(appId, cardId);
    if (session && session.wid) return session;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function connectCardRuntimeWebSocket(cardWinHex, appId, cardId, reattachTxIds) {
  return new Promise((resolve) => {
    const params = new URLSearchParams({
      cardWin: cardWinHex,
      appId,
      cardId,
    });
    if (Array.isArray(reattachTxIds) && reattachTxIds.length > 0) {
      params.set('reattachTxIds', reattachTxIds.join(','));
    }
    const wsUrl = `ws://localhost:${HTTP_PORT}/ws?${params.toString()}`;
    const ws = new WebSocket(wsUrl);
    let settled = false;

    const finish = (sock) => {
      if (!settled) {
        settled = true;
        resolve(sock);
      }
    };

    const timer = setTimeout(() => finish(ws), 2000);
    ws.on('open', () => {
      clearTimeout(timer);
      finish(ws);
    });
    ws.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
  });
}

function normalizeBlobHex(raw) {
  const num = parseWindowId(raw);
  return num ? `0x${num.toString(16)}` : (raw ? String(raw) : null);
}

function createCardNatHelpers(cardSession) {
  cardSession.blobNatTable = cardSession.blobNatTable || new Map();
  cardSession.channelNatTable = cardSession.channelNatTable || new Map();
  cardSession._remapWaiters = cardSession._remapWaiters || new Map();
  cardSession._remappedHistory = cardSession._remappedHistory || new Map();
  cardSession._migrateCompleteWaiters = cardSession._migrateCompleteWaiters || [];

  cardSession.getNatInfo = (kindOrBlob, id) => {
    const isIdOmitted = id === undefined;
    const kind = isIdOmitted ? 'blob' : (kindOrBlob === 'channel' || kindOrBlob === 'xchannel' ? 'channel' : 'blob');
    const targetId = isIdOmitted ? kindOrBlob : id;
    if (kind === 'channel') {
      const chNum = Number(targetId);
      return cardSession.channelNatTable.get(chNum) ?? chNum;
    }
    const norm = normalizeBlobHex(targetId);
    return cardSession.blobNatTable.get(norm) || norm;
  };

  cardSession.whenRemapped = (kindOrBlob, id) => {
    const isIdOmitted = id === undefined;
    const kind = isIdOmitted ? 'blob' : (kindOrBlob === 'channel' || kindOrBlob === 'xchannel' ? 'channel' : 'blob');
    const targetId = isIdOmitted ? kindOrBlob : id;
    const key = kind === 'channel' ? `channel:${Number(targetId)}` : `blob:${normalizeBlobHex(targetId)}`;
    if (cardSession._remappedHistory.has(key)) {
      return Promise.resolve(cardSession._remappedHistory.get(key));
    }
    return new Promise((resolve) => {
      const list = cardSession._remapWaiters.get(key) || [];
      list.push(resolve);
      cardSession._remapWaiters.set(key, list);
    });
  };

  cardSession.recordRemap = (kind, virtualId, localId) => {
    if (kind === 'channel') {
      const vTx = Number(virtualId);
      const lTx = Number(localId);
      if (isNaN(vTx) || isNaN(lTx)) return;
      cardSession.channelNatTable.set(vTx, lTx);
      const key = `channel:${vTx}`;
      cardSession._remappedHistory.set(key, lTx);
      const waiters = cardSession._remapWaiters.get(key) || [];
      cardSession._remapWaiters.delete(key);
      waiters.forEach((fn) => { try { fn(lTx); } catch (_) {} });
      return;
    }
    const vHex = normalizeBlobHex(virtualId);
    const lHex = normalizeBlobHex(localId);
    if (!vHex || !lHex) return;
    cardSession.blobNatTable.set(vHex, lHex);
    const key = `blob:${vHex}`;
    cardSession._remappedHistory.set(key, lHex);
    const waiters = cardSession._remapWaiters.get(key) || [];
    cardSession._remapWaiters.delete(key);
    waiters.forEach((fn) => { try { fn(lHex); } catch (_) {} });
  };

  cardSession.waitForMigrateComplete = (timeoutMs = 1500) => {
    if (cardSession.migrateComplete) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      cardSession._migrateCompleteWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  };
}

function postJsonToBridge(urlPath, bodyObj) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(bodyObj || {});
    const req = http.request(
      `${HTTP_BASE_URL}${urlPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        timeout: 2500,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            return resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (_) {
            return resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(bodyStr);
    req.end();
  });
}

function attachCardSessionWsListener(ws, cardSession, newCardWinHex) {
  createCardNatHelpers(cardSession);
  if (!ws) return;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString('utf8'));
      const evName = msg.event || msg.intent;
      if (evName === 'sys.XBlobTransferred') {
        const vId = msg.blobId || msg.virtualBlobId;
        const lId = msg.dataBlob || msg.nattedBlobId || msg.localBlobId;
        if (vId && lId) {
          cardSession.recordRemap('blob', vId, lId);
          logger.info(`[NAT] Card ${newCardWinHex} remapped virtual blob ${vId} -> local ${lId}`);
        }
        cardSession.receivedBlobEvents.push(msg);
      } else if (evName === 'sys.ChannelRedirect') {
        const vTx = msg.cardTxId ?? msg.txId ?? msg.channel;
        const lTx = msg.localChannelId ?? msg.txId ?? msg.channel;
        if (vTx !== undefined && lTx !== undefined) {
          cardSession.recordRemap('channel', vTx, lTx);
          logger.info(`[NAT] Card ${newCardWinHex} redirected channel txId=${vTx} -> local=${lTx}`);
        }
        cardSession.receivedFrames.push(msg);
      } else if (evName === 'sys.LiveMigrateComplete') {
        cardSession.migrateComplete = true;
        const waiters = cardSession._migrateCompleteWaiters.splice(0);
        waiters.forEach((fn) => { try { fn(msg); } catch (_) {} });
        logger.info(`[NAT] Card ${newCardWinHex} received sys.LiveMigrateComplete`);
      } else if (msg.event === 'XBLOB_BROADCAST_V0' || msg.event === 'XBLOB_STREAM_CLOSED_V0') {
        cardSession.receivedBlobEvents.push(msg);
        logger.info(`Card ${newCardWinHex} received ${msg.event} for blob ${msg.blobId}`);
      } else {
        cardSession.receivedFrames.push(msg);
        logger.info(`Card ${newCardWinHex} received XChannel frame on txId=${msg.txId || msg.channel}: ${msg.event || msg.intent || 'frame'}`);
      }
    } catch (_) {}
  });
}

function httpJsonRequest(urlStr, method = 'GET', bodyObj = null, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const parsed = new URL(urlStr);
    const bodyStr = bodyObj !== null ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: bodyStr
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(bodyStr),
            }
          : {},
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (_) {
            resolve({ status: res.statusCode, body: null });
          }
        });
      }
    );
    req.on('error', () => resolve({ status: 0, body: null }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: null });
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function launchWebDriverBrowser(cardUrl, newCardWinHex, cardSession) {
  const geckodriverBin = fs.existsSync('/snap/firefox/current/usr/lib/firefox/geckodriver')
    ? '/snap/firefox/current/usr/lib/firefox/geckodriver'
    : fs.existsSync('/snap/bin/geckodriver')
      ? '/snap/bin/geckodriver'
      : 'geckodriver';
  const firefoxBinary = fs.existsSync('/usr/lib/firefox/firefox')
    ? '/usr/lib/firefox/firefox'
    : undefined;
  const gdPort = nextWebDriverPort++;
  const webdriverUrl = `http://127.0.0.1:${gdPort}`;

  const gdProc = spawn(geckodriverBin, ['--port', String(gdPort)], {
    detached: true,
    env: {
      ...process.env,
      DISPLAY: BROWSER_DISPLAY,
      MOZ_DISABLE_CONTENT_SANDBOX: '1',
    },
    stdio: 'ignore',
  });
  gdProc.unref();
  if (cardSession) {
    cardSession.gdProc = gdProc;
    cardSession.webdriverUrl = webdriverUrl;
    cardSession.browserDisplay = BROWSER_DISPLAY;
    cardSession.runtimeHost = RUNTIME_HOST;
  }

  for (let i = 0; i < 40; i++) {
    const statusRes = await httpJsonRequest(`${webdriverUrl}/status`, 'GET', null, 500);
    if (statusRes.status === 200) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const ffArgs = ['--no-remote', '-width', '1024', '-height', '768'];
  if (
    (process.env.XHTML_HEADLESS === '1' || process.env.XHTML_HEADLESS === 'true') &&
    !process.env.XHTML_DISPLAY &&
    !hasCliFlag(['--display', '--xhtml-display'])
  ) {
    ffArgs.push('-headless');
  }

  const ffOptions = {
    args: ffArgs,
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

  const createRes = await httpJsonRequest(
    `${webdriverUrl}/session`,
    'POST',
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

  const sessionId = createRes.body?.value?.sessionId || null;
  if (sessionId) {
    if (cardSession) {
      cardSession.webdriverSessionId = sessionId;
      cardSession.browserPid = createRes.body?.value?.capabilities?.['moz:processID'] || null;
    }
    await httpJsonRequest(
      `${webdriverUrl}/session/${encodeURIComponent(sessionId)}/url`,
      'POST',
      { url: cardUrl }
    );
    await postJsonToBridge('/api/card-session', {
      cardWin: newCardWinHex,
      appId: cardSession?.cardApp,
      cardId: cardSession?.cardId,
      runtimeHost: RUNTIME_HOST,
      browserDisplay: BROWSER_DISPLAY,
      webdriverUrl,
      webdriverSessionId: sessionId,
    });
    logger.info(
      `[${RUNTIME_HOST}] Launched WebDriver Firefox (display=${BROWSER_DISPLAY}, session=${sessionId} at ${webdriverUrl}) for card ${newCardWinHex}: ${cardUrl}`
    );
  } else {
    logger.warn(`[${RUNTIME_HOST}] Failed creating WebDriver session on ${webdriverUrl} for ${cardUrl}: ${JSON.stringify(createRes)}`);
  }
  return gdProc;
}

async function launchCardBrowserWindow(cardUrl, newCardWinHex, cardSession = null) {
  const customCmd = process.env.XHTML_BROWSER_CMD;
  if (customCmd === 'none' || customCmd === 'false' || customCmd === '0') {
    return null;
  }

  try {
    await postJsonToBridge('/api/card-session', {
      cardWin: newCardWinHex,
      appId: cardSession?.cardApp,
      cardId: cardSession?.cardId,
      runtimeHost: RUNTIME_HOST,
      browserDisplay: BROWSER_DISPLAY,
    });

    if (WEBDRIVER_ENABLED) {
      return await launchWebDriverBrowser(cardUrl, newCardWinHex, cardSession);
    }

    if (customCmd) {
      const proc = spawn(`${customCmd} "${cardUrl}"`, {
        shell: true,
        detached: true,
        env: { ...process.env, DISPLAY: BROWSER_DISPLAY, MOZ_DISABLE_CONTENT_SANDBOX: '1' },
        stdio: 'ignore',
      });
      proc.unref();
      logger.info(`Launched custom XHTML_BROWSER_CMD (${customCmd}) on ${BROWSER_DISPLAY} for ${cardUrl}`);
      return proc;
    }

    const firefoxBin = fs.existsSync('/usr/lib/firefox/firefox')
      ? '/usr/lib/firefox/firefox'
      : '/usr/bin/firefox';
    if (!fs.existsSync(firefoxBin)) {
      logger.warn(`${firefoxBin} not found; skipping browser window launch`);
      return null;
    }

    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `xhtml-ff-${newCardWinHex}-`));
    tempProfileDirs.add(profileDir);
    fs.writeFileSync(
      path.join(profileDir, 'user.js'),
      [
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("browser.tabs.warnOnClose", false);',
        'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
        'user_pref("trailhead.firstrun.didSeeAboutWelcome", true);',
      ].join('\n'),
      'utf8'
    );

    const args = ['--no-remote', '--profile', profileDir];
    if (process.env.XHTML_HEADLESS === '1' || process.env.XHTML_HEADLESS === 'true') {
      args.push('--headless');
    } else {
      args.push('--new-window');
    }
    args.push(cardUrl);

    const proc = spawn(firefoxBin, args, {
      detached: true,
      env: { ...process.env, DISPLAY: BROWSER_DISPLAY, MOZ_DISABLE_CONTENT_SANDBOX: '1' },
      stdio: 'ignore',
    });
    proc.unref();
    logger.info(`[${RUNTIME_HOST}] Launched Firefox (${args.join(' ')}) on ${BROWSER_DISPLAY} for card ${newCardWinHex}`);
    return proc;
  } catch (err) {
    logger.warn(`Failed to launch browser for ${cardUrl}:`, err.message);
    return null;
  }
}

function extractSnapshotJson(blobResult) {
  if (!blobResult) return {};
  const data = blobResult.data !== undefined ? blobResult.data : blobResult;
  if (Buffer.isBuffer(data)) {
    try {
      return JSON.parse(data.toString('utf8'));
    } catch (_) {
      return {};
    }
  }
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch (_) {
      return {};
    }
  }
  if (typeof data === 'object' && data !== null) {
    return data;
  }
  return {};
}

function resolveTargetCardFromPayload(payload = {}) {
  const explicitApp = payload.cardApp || payload.appId || payload.package;
  const rawAppField = payload.app;
  const fallbackApp =
    rawAppField &&
    rawAppField !== 'cool-xhtml-runtime' &&
    !String(rawAppField).endsWith(':cool-xhtml-runtime')
      ? rawAppField
      : 'cool-xhtml-runtime';
  const cardApp = explicitApp || fallbackApp;
  const cardId = payload.cardId || payload.card || 'index';
  return { cardApp, cardId };
}

async function handleLoadCardIntent(X, root, runtimeWin, frame) {
  const { senderWin, payload, channel } = frame;
  const { cardApp, cardId } = resolveTargetCardFromPayload(payload);

  logger.info(
    `Received ${payload?.intent || 'xhtml.LoadCard'} for ${cardApp}/${cardId} from ${xintent.widString(senderWin)} (channel=${channel})`
  );

  const bridgeSession = await allocateBridgeCardSession(cardApp, cardId);
  let newCardWin = bridgeSession?.wid || 0;
  if (!newCardWin) {
    newCardWin = await xintent.createClientWindow(X, root, `${cardApp}:${cardId}`);
  }
  const newCardWinHex = xintent.widString(newCardWin);

  const ws = await connectCardRuntimeWebSocket(newCardWinHex, cardApp, cardId, []);
  const cardSession = {
    cardWin: newCardWin,
    cardWinHex: newCardWinHex,
    cardApp,
    cardId,
    ws,
    receivedFrames: [],
    receivedBlobEvents: [],
    loadedAt: Date.now(),
  };
  activeCards.set(newCardWinHex, cardSession);
  attachCardSessionWsListener(ws, cardSession, newCardWinHex);

  const extraQuery = payload?.query && typeof payload.query === 'object'
    ? '&' + new URLSearchParams(payload.query).toString()
    : '';
  const cardUrl = `${HTTP_BASE_URL}/apps/${encodeURIComponent(cardApp)}/${encodeURIComponent(cardId)}?cardWin=${encodeURIComponent(newCardWinHex)}&cardId=${encodeURIComponent(cardId)}${extraQuery}`;
  cardSession.browserProc = await launchCardBrowserWindow(cardUrl, newCardWinHex, cardSession);

  if (channel) {
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      senderWin: runtimeWin,
      channel,
      controlWord: 2, // FIN
      payload: {
        event: 'xhtml.LoadCardResponse',
        disposition: 'final',
        status: 'ok',
        host: RUNTIME_HOST,
        display: BROWSER_DISPLAY,
        cardApp,
        cardId,
        cardWin: newCardWinHex,
        cardUrl,
        webdriverUrl: cardSession.webdriverUrl || null,
        webdriverSessionId: cardSession.webdriverSessionId || null,
      },
    });
  }

  logger.info(`Completed xhtml.LoadCard for ${cardApp}/${cardId} -> cardWin=${newCardWinHex}`);
}

async function stopCardBrowserProcess(cardSession) {
  if (!cardSession) return;
  if (cardSession.webdriverUrl && cardSession.webdriverSessionId) {
    const sid = cardSession.webdriverSessionId;
    cardSession.webdriverSessionId = null;
    try {
      await httpJsonRequest(
        `${cardSession.webdriverUrl}/session/${encodeURIComponent(sid)}`,
        'DELETE',
        null,
        2000
      );
      await postJsonToBridge('/api/card-session', {
        cardWin: cardSession.cardWinHex,
        webdriverSessionId: null,
      });
    } catch (_) {}
  }
  if (cardSession.browserPid) {
    const bpid = cardSession.browserPid;
    cardSession.browserPid = null;
    try {
      process.kill(bpid, 'SIGKILL');
    } catch (_) {}
  }
  if (cardSession.gdProc) {
    const gd = cardSession.gdProc;
    cardSession.gdProc = null;
    if (gd.pid) {
      try {
        process.kill(-gd.pid, 'SIGKILL');
      } catch (_) {
        try { gd.kill('SIGKILL'); } catch (_) {}
      }
    }
  }
  if (cardSession.browserProc) {
    const proc = cardSession.browserProc;
    cardSession.browserProc = null;
    if (proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch (_) {
        try { proc.kill('SIGTERM'); } catch (_) {}
      }
    }
  }
}

const busEventWaiters = [];

function resolveBusEventWaiters(parsed) {
  if (!parsed) return false;
  const evName = parsed?.payload?.event || parsed?.payload?.intent;
  let matched = false;
  for (let i = busEventWaiters.length - 1; i >= 0; i--) {
    const waiter = busEventWaiters[i];
    if (
      (evName && waiter.matchEvents.includes(evName)) ||
      (waiter.txId && parsed.channel === waiter.txId && evName)
    ) {
      busEventWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
      matched = true;
    }
  }
  return matched;
}

async function sendBusIntentAndWaitEvent(X, runtimeWin, payload, dataBlob, matchEvents, timeoutMs = 4000) {
  const txId = Math.floor(Math.random() * 1000000) + 1000;
  const waitPromise = new Promise((resolve) => {
    const waiter = {
      txId,
      matchEvents: Array.isArray(matchEvents) ? matchEvents : [matchEvents],
      resolve,
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      const idx = busEventWaiters.indexOf(waiter);
      if (idx !== -1) busEventWaiters.splice(idx, 1);
      resolve({ timedOut: true });
    }, timeoutMs);
    busEventWaiters.push(waiter);
  });

  await xintent.sendXIntentIntentV0(X, xintent.routerWin, {
    senderWin: runtimeWin,
    txId,
    controlWord: 1,
    payload,
    dataBlob: dataBlob || 0,
  });

  return waitPromise;
}

async function initiateOutgoingLiveMigration(X, root, runtimeWin, frame) {
  const { senderWin, payload, channel, dataBlob } = frame;
  const targetHost = payload.targetHost || (payload.targetRuntime?.includes(':') ? payload.targetRuntime.split(':')[0] : 'user-desktop');
  const targetRuntime = payload.targetRuntime || `${targetHost}:cool-xhtml-runtime`;

  let oldCardWin = parseWindowId(payload.oldCardWin || payload.cardWin);
  let sourceSession = oldCardWin ? activeCards.get(xintent.widString(oldCardWin)) : null;
  if (!sourceSession) {
    const requestedApp = payload.cardApp || payload.appId || 'cool-terminal';
    for (const sess of activeCards.values()) {
      if (sess.cardApp === requestedApp) {
        sourceSession = sess;
        oldCardWin = sess.cardWin;
        break;
      }
    }
  }
  if (!oldCardWin) {
    oldCardWin = senderWin;
  }
  const oldCardWinHex = xintent.widString(oldCardWin);
  const cardApp = payload.cardApp || sourceSession?.cardApp || 'cool-terminal';
  const cardId = payload.cardId || sourceSession?.cardId || 'index';

  logger.info(
    `[${RUNTIME_HOST}] Initiating live migration of ${cardApp}/${cardId} (${oldCardWinHex}) -> ${targetRuntime}`
  );

  // Step 1: Send sys.BeginLiveMigrate to local X busmaster and drain until sys.BeginLiveMigrateResponse
  await sendBusIntentAndWaitEvent(
    X,
    runtimeWin,
    {
      intent: 'sys.BeginLiveMigrate',
      cardWin: oldCardWinHex,
      oldCardWin: oldCardWinHex,
    },
    0,
    ['sys.BeginLiveMigrateResponse'],
    2000
  );

  // Step 2: Freeze the card process, grab its current state, and send sys.LiveMigrate with Connection: keep-alive
  let snapshot = null;
  let stateBlobAtom = parseWindowId(dataBlob || payload.stateBlob || payload.blob);
  if (stateBlobAtom) {
    try {
      const raw = await xintent.XBlobRead(X, xintent.routerWin, stateBlobAtom);
      snapshot = extractSnapshotJson(raw);
    } catch (_) {}
  }
  if (!snapshot || Object.keys(snapshot).length === 0) {
    const snapRes = await postJsonToBridge(`/api/card-snapshot/${encodeURIComponent(oldCardWinHex)}`, {
      freeze: true,
    });
    snapshot = snapRes?.snapshot || sourceSession?.snapshot || {
      version: '0.1',
      cardApp,
      cardId,
      cardWin: oldCardWinHex,
    };
  }
  if (!stateBlobAtom) {
    stateBlobAtom = await xintent.XBlobCreate(X, xintent.routerWin, runtimeWin, {
      xblobType: 'Blob',
      type: 'application/json',
      name: `${cardApp}-${cardId}.xhtml-snapshot.json`,
      data: snapshot,
    });
  }

  // Stop the old card's browser process now that it is frozen and snapshotted
  if (sourceSession) {
    await stopCardBrowserProcess(sourceSession);
  }

  // Step 2 & 3: Send sys.LiveMigrate to remote runtime with Connection: keep-alive and wait for sys.LiveMigrateResponse
  const migrateRespFrame = await sendBusIntentAndWaitEvent(
    X,
    runtimeWin,
    {
      intent: 'sys.LiveMigrate',
      app: targetRuntime,
      cardApp,
      cardId,
      oldCardWin: oldCardWinHex,
      Connection: 'keep-alive',
      deferCommit: true,
    },
    stateBlobAtom,
    ['sys.LiveMigrateResponse', 'xhtml.LiveMigrateResponse'],
    4000
  );

  const migrateRespPayload = migrateRespFrame?.payload || {};
  const newCardWinHex = migrateRespPayload.remoteWin || migrateRespPayload.newCardWin;
  const remoteRuntimeWin = migrateRespPayload.remoteRuntimeWin || xintent.widString(migrateRespFrame?.senderWin || 0);

  // Step 4 & 5: Send sys.LiveMigrateCommit to local X busmaster and wait for sys.LiveMigrateCommitResponse
  let commitRespPayload = {};
  if (newCardWinHex) {
    const commitRespFrame = await sendBusIntentAndWaitEvent(
      X,
      runtimeWin,
      {
        intent: 'sys.LiveMigrateCommit',
        oldCardWin: oldCardWinHex,
        newCardWin: newCardWinHex,
        remoteWin: newCardWinHex,
        remoteRuntimeWin,
        stateBlobId: xintent.widString(stateBlobAtom),
        excludeBlobs: [xintent.widString(stateBlobAtom)],
        heldBlobs: snapshot.heldBlobs || [],
        openChannels: snapshot.openChannels || [],
        natTables: snapshot.natTables || {},
      },
      0,
      ['sys.LiveMigrateCommitResponse'],
      4000
    );
    commitRespPayload = commitRespFrame?.payload || {};
  }

  if (sourceSession) {
    activeCards.delete(oldCardWinHex);
  }

  const reqIntent = payload.intent || payload.action || 'xhtml.MigrateCard';
  const responseEvent = reqIntent.endsWith('MigrateCard')
    ? `${reqIntent}Response`
    : (reqIntent === 'sys.LiveMigrate' ? 'sys.LiveMigrateResponse' : 'xhtml.LiveMigrateResponse');

  if (channel) {
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      senderWin: runtimeWin,
      channel,
      controlWord: 2,
      payload: {
        event: responseEvent,
        disposition: 'final',
        status: 'ok',
        cardApp,
        cardId,
        sourceHost: RUNTIME_HOST,
        targetRuntime,
        oldCardWin: oldCardWinHex,
        newCardWin: newCardWinHex,
        remoteWin: newCardWinHex,
        migratedChannels: commitRespPayload.migratedChannels || [],
        transferredBlobs: commitRespPayload.transferredBlobs || [],
      },
    });
  }

  logger.info(
    `[${RUNTIME_HOST}] Completed outgoing live migration of ${cardApp}/${cardId}: ${oldCardWinHex} -> ${newCardWinHex} on ${targetRuntime}`
  );
}

async function handleLiveMigrateIntent(X, root, runtimeWin, frame) {
  const { senderWin, payload = {}, channel, dataBlob } = frame;
  const intentName = payload.intent || payload.action || 'xhtml.LiveMigrate';

  // If this runtime is being asked to migrate a local card to a different remote host, run the initiator flow
  const explicitTargetHost = payload.targetHost || (payload.targetRuntime?.includes(':') ? payload.targetRuntime.split(':')[0] : null);
  if (
    intentName === 'xhtml.MigrateCard' ||
    intentName === 'sys.MigrateCard' ||
    (explicitTargetHost && explicitTargetHost !== RUNTIME_HOST)
  ) {
    return await initiateOutgoingLiveMigration(X, root, runtimeWin, frame);
  }

  const cardApp = payload.cardApp || payload.appId || 'xhtml-card';
  const cardId = payload.cardId || 'main';
  const cardEntry = payload.cardEntry || 'index.xhtml';
  const oldCardWin = parseWindowId(payload.oldCardWin || payload.cardWin) || senderWin;
  let stateBlobAtom = parseWindowId(dataBlob || payload.stateBlob || payload.blob);

  logger.info(
    `[${RUNTIME_HOST}] Received ${intentName} for ${cardApp}/${cardId} from oldCardWin=${xintent.widString(oldCardWin)} (stateBlob=${xintent.widString(stateBlobAtom)}, channel=${channel})`
  );

  // Stop old browser process if migrating from the same host
  const oldSessionOnThisRuntime = activeCards.get(xintent.widString(oldCardWin));
  if (oldSessionOnThisRuntime) {
    await stopCardBrowserProcess(oldSessionOnThisRuntime);
  }

  // 1. Read the state snapshot blob (or request snapshot from bridge if not attached)
  let snapshot = {};
  if (stateBlobAtom) {
    try {
      const rawBlob = await xintent.XBlobRead(X, xintent.routerWin, stateBlobAtom);
      snapshot = extractSnapshotJson(rawBlob);
    } catch (err) {
      logger.error(`Failed to read state snapshot blob ${xintent.widString(stateBlobAtom)}:`, err.message);
    }
  } else if (oldCardWin) {
    const snapRes = await postJsonToBridge(`/api/card-snapshot/${encodeURIComponent(xintent.widString(oldCardWin))}`, {
      freeze: true,
    });
    if (snapRes?.snapshot) {
      snapshot = snapRes.snapshot;
      stateBlobAtom = await xintent.XBlobCreate(X, xintent.routerWin, runtimeWin, {
        xblobType: 'Blob',
        type: 'application/json',
        name: `${cardApp}-${cardId}.xhtml-snapshot.json`,
        data: snapshot,
      });
    }
  }

  const resolvedCardApp = snapshot.cardApp || cardApp;
  const resolvedCardId = snapshot.cardId || cardId;

  // 2. Allocate dedicated newCardWin on cool-http-bridge (or fallback to direct X11 window)
  const bridgeSession = await allocateBridgeCardSession(resolvedCardApp, resolvedCardId);
  let newCardWin = bridgeSession?.wid || 0;
  if (!newCardWin) {
    newCardWin = await xintent.createClientWindow(X, root, `${resolvedCardApp}:${resolvedCardId}`);
  }
  const newCardWinHex = xintent.widString(newCardWin);

  // 3. Re-attach open XChannels via WebSocket on cool-http-bridge BEFORE uncorking
  const reattachTxIds = (snapshot.openChannels || [])
    .map((ch) => Number(typeof ch === 'object' ? ch.txId : ch))
    .filter((n) => !isNaN(n) && n > 0);

  const ws = await connectCardRuntimeWebSocket(newCardWinHex, resolvedCardApp, resolvedCardId, reattachTxIds);
  const cardSession = {
    cardWin: newCardWin,
    cardWinHex: newCardWinHex,
    oldCardWin: xintent.widString(oldCardWin),
    cardApp: resolvedCardApp,
    cardId: resolvedCardId,
    cardEntry,
    snapshot,
    ws,
    receivedFrames: [],
    receivedBlobEvents: [],
    migratedAt: Date.now(),
  };
  activeCards.set(newCardWinHex, cardSession);
  attachCardSessionWsListener(ws, cardSession, newCardWinHex);

  if (snapshot.natTables?.blobNat) {
    for (const [vId, lId] of Object.entries(snapshot.natTables.blobNat)) {
      cardSession.recordRemap('blob', vId, lId);
    }
  }
  if (snapshot.natTables?.channelNat) {
    for (const [vTx, lTx] of Object.entries(snapshot.natTables.channelNat)) {
      cardSession.recordRemap('channel', vTx, lTx);
    }
  }

  // Transfer state snapshot blob ownership to newCardWin so the browser can read & unlink ?hydrateBlob=0x...
  if (stateBlobAtom) {
    try {
      if (newCardWin) {
        await xintent.XBlobGrant(X, xintent.routerWin, runtimeWin, stateBlobAtom, newCardWin);
      }
      await xintent.XBlobUnlink(X, xintent.routerWin, runtimeWin, stateBlobAtom);
    } catch (_) {}
  }

  const isTwoPhaseProtocol = Boolean(payload.deferCommit || intentName === 'sys.LiveMigrate');
  const responseEventName = intentName === 'sys.LiveMigrate' ? 'sys.LiveMigrateResponse' : 'xhtml.LiveMigrateResponse';

  if (isTwoPhaseProtocol) {
    // Step 3 of polyfills.md: sys.LiveMigrateResponse comes back with the remote window ID
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      senderWin: runtimeWin,
      channel,
      controlWord: 2,
      payload: {
        event: responseEventName,
        disposition: 'final',
        status: 'ok',
        host: RUNTIME_HOST,
        cardApp: resolvedCardApp,
        cardId: resolvedCardId,
        cardEntry,
        oldCardWin: xintent.widString(oldCardWin),
        newCardWin: newCardWinHex,
        remoteWin: newCardWinHex,
        remoteRuntimeWin: xintent.widString(runtimeWin),
        hydratedState: {
          localStorageKeys: Object.keys(snapshot.localStorage || snapshot.storage?.localStorage || {}),
          heldBlobs: snapshot.heldBlobs || [],
          softLinkedBlobs: snapshot.softLinkedBlobs || [],
          reattachedTxIds: reattachTxIds,
        },
      },
    });

    // Wait for Step 5 (sys.LiveMigrateComplete) after caller sends sys.LiveMigrateCommit
    await cardSession.waitForMigrateComplete(1500);
    const cardUrl = `${HTTP_BASE_URL}/apps/${encodeURIComponent(resolvedCardApp)}/${encodeURIComponent(resolvedCardId)}?cardWin=${encodeURIComponent(newCardWinHex)}&cardId=${encodeURIComponent(resolvedCardId)}${stateBlobAtom ? `&hydrateBlob=${encodeURIComponent(xintent.widString(stateBlobAtom))}` : ''}`;
    cardSession.browserProc = await launchCardBrowserWindow(cardUrl, newCardWinHex, cardSession);
    logger.info(`[${RUNTIME_HOST}] Thawed and launched card ${resolvedCardApp}/${resolvedCardId} -> newCardWin=${newCardWinHex} on sys.LiveMigrateComplete`);
    return;
  }

  // Single-shot xhtml.LiveMigrate compatibility: trigger sys.LiveMigrateCommit on busmaster so NAT & channels redirect
  if (oldCardWin && newCardWin && oldCardWin !== newCardWin) {
    await sendBusIntentAndWaitEvent(
      X,
      runtimeWin,
      {
        intent: 'sys.LiveMigrateCommit',
        oldCardWin: xintent.widString(oldCardWin),
        newCardWin: newCardWinHex,
        remoteWin: newCardWinHex,
        remoteRuntimeWin: xintent.widString(runtimeWin),
        stateBlobId: stateBlobAtom ? xintent.widString(stateBlobAtom) : undefined,
        excludeBlobs: stateBlobAtom ? [xintent.widString(stateBlobAtom)] : [],
        heldBlobs: snapshot.heldBlobs || [],
        openChannels: snapshot.openChannels || [],
        natTables: snapshot.natTables || {},
      },
      0,
      ['sys.LiveMigrateCommitResponse'],
      2000
    );
  }

  const cardUrl = `${HTTP_BASE_URL}/apps/${encodeURIComponent(resolvedCardApp)}/${encodeURIComponent(resolvedCardId)}?cardWin=${encodeURIComponent(newCardWinHex)}&cardId=${encodeURIComponent(resolvedCardId)}${stateBlobAtom ? `&hydrateBlob=${encodeURIComponent(xintent.widString(stateBlobAtom))}` : ''}`;
  cardSession.browserProc = await launchCardBrowserWindow(cardUrl, newCardWinHex, cardSession);

  await xintent.sendXIntentEventV0(X, xintent.routerWin, {
    senderWin: runtimeWin,
    channel,
    controlWord: 2, // FIN
    payload: {
      event: responseEventName,
      disposition: 'final',
      status: 'ok',
      host: RUNTIME_HOST,
      cardApp: resolvedCardApp,
      cardId: resolvedCardId,
      cardEntry,
      oldCardWin: xintent.widString(oldCardWin),
      newCardWin: newCardWinHex,
      remoteWin: newCardWinHex,
      remoteRuntimeWin: xintent.widString(runtimeWin),
      hydratedState: {
        localStorageKeys: Object.keys(snapshot.localStorage || snapshot.storage?.localStorage || {}),
        heldBlobs: snapshot.heldBlobs || [],
        softLinkedBlobs: snapshot.softLinkedBlobs || [],
        reattachedTxIds: reattachTxIds,
      },
    },
  });

  logger.info(`[${RUNTIME_HOST}] Completed ${intentName} for ${resolvedCardApp}/${resolvedCardId} -> newCardWin=${newCardWinHex}`);
}

async function startRuntime() {
  xintent.init({ logger: new Logger({ module: 'libxintent' }) });
  const { X, root } = await x11.createClientWithPromises();
  await xintent.connectToRouter(X, root);

  if (!xintent.routerWin) {
    logger.error('Could not connect to XINTENT router');
    process.exit(1);
  }

  const runtimeWin = await xintent.createClientWindow(X, root, 'cool-xhtml-runtime');

  X.on('event', async (ev) => {
    if (
      ev.type === 33 &&
      (ev.message_type === xintent.atoms.XINTENT_INTENT_V0 ||
        ev.message_type === xintent.atoms.XINTENT_EVENT_V0)
    ) {
      try {
        const frame = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
        if (resolveBusEventWaiters(frame)) {
          return;
        }
        const intentName = frame.payload?.intent || frame.payload?.event || frame.payload?.action;
        if (
          intentName === 'xhtml.LiveMigrate' ||
          intentName === 'sys.LiveMigrate' ||
          intentName === 'xhtml.MigrateCard' ||
          intentName === 'sys.MigrateCard'
        ) {
          await handleLiveMigrateIntent(X, root, runtimeWin, frame);
        } else if (intentName === 'xhtml.LoadCard' || intentName === 'fs.Open') {
          await handleLoadCardIntent(X, root, runtimeWin, frame);
        } else if (intentName === 'sys.XBlobTransferred') {
          const targetHex = normalizeBlobHex(frame.payload?.newCardWin || frame.payload?.remoteWin);
          const sess = targetHex ? activeCards.get(targetHex) : null;
          const vId = frame.payload?.blobId || frame.payload?.virtualBlobId;
          const lId = frame.dataBlob ? xintent.widString(frame.dataBlob) : null;
          if (sess && vId && lId) {
            sess.recordRemap('blob', vId, lId);
            await postJsonToBridge('/api/card-nat', {
              cardWin: targetHex,
              blobNatTable: { [vId]: lId },
            });
          }
          await xintent.sendXIntentEventV0(X, xintent.routerWin, {
            targetWin: xintent.routerWin,
            senderWin: runtimeWin,
            txId: frame.channel || 0,
            controlWord: 2,
            payload: {
              event: 'sys.XBlobTransferredResponse',
              intent: 'sys.XBlobTransferredResponse',
              status: 'ok',
              blobId: vId,
              nattedBlobId: lId,
            },
          });
        } else if (intentName === 'sys.ChannelRedirect') {
          const targetHex = normalizeBlobHex(frame.payload?.newCardWin || frame.payload?.remoteWin);
          const sess = targetHex ? activeCards.get(targetHex) : null;
          const vTx = frame.payload?.cardTxId ?? frame.payload?.txId ?? frame.channel;
          const lTx = frame.payload?.localChannelId ?? frame.payload?.txId ?? frame.channel;
          if (sess && vTx !== undefined && lTx !== undefined) {
            sess.recordRemap('channel', vTx, lTx);
            await postJsonToBridge('/api/card-nat', {
              cardWin: targetHex,
              channelNatTable: { [String(vTx)]: Number(lTx) },
            });
          }
          await xintent.sendXIntentEventV0(X, xintent.routerWin, {
            targetWin: xintent.routerWin,
            senderWin: runtimeWin,
            txId: frame.channel || 0,
            controlWord: 2,
            payload: {
              event: 'sys.ChannelRedirectResponse',
              intent: 'sys.ChannelRedirectResponse',
              status: 'ok',
              channel: frame.payload?.channel,
              txId: vTx,
            },
          });
        } else if (intentName === 'sys.LiveMigrateComplete') {
          const oldHex = normalizeBlobHex(frame.payload?.oldCardWin);
          const targetHex = normalizeBlobHex(frame.payload?.newCardWin || frame.payload?.remoteWin);
          if (oldHex && oldHex !== targetHex && activeCards.has(oldHex)) {
            const oldSess = activeCards.get(oldHex);
            activeCards.delete(oldHex);
            setTimeout(() => {
              stopCardBrowserProcess(oldSess).catch(() => {});
            }, 600);
          }
          const sess = targetHex ? activeCards.get(targetHex) : null;
          if (sess) {
            sess.migrateComplete = true;
            const waiters = sess._migrateCompleteWaiters.splice(0);
            waiters.forEach((fn) => { try { fn(frame.payload); } catch (_) {} });
          }
        }
      } catch (err) {
        logger.error('Error handling intent in cool-xhtml-runtime:', err);
      }
    }
  });

  X.ChangeProperty(
    0,
    runtimeWin,
    xintent.atoms.MATCHBOX_TOML,
    xintent.atoms.STRING,
    8,
    Buffer.from(MATCHBOX_TOML_MANIFEST, 'utf8')
  );

  logger.info(`cool-xhtml-runtime online on window ${xintent.widString(runtimeWin)} (router: ${xintent.widString(xintent.routerWin)})`);
}

startRuntime().catch((err) => {
  logger.error('Fatal startup error in cool-xhtml-runtime:', err);
  process.exit(1);
});
