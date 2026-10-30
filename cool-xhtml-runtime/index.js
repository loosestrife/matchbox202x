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

const MATCHBOX_TOML_MANIFEST = `
[app]
id = "cool-xhtml-runtime"
name = "Cool XHTML Runtime"
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

[intents."fs.Open"]
invocation = "X11"
`;

const activeCards = new Map(); // widHex -> cardSession
const tempProfileDirs = new Set();

function cleanupSpawnedBrowsers() {
  for (const session of activeCards.values()) {
    const proc = session.browserProc;
    if (proc && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM');
      } catch (_) {
        try { proc.kill('SIGTERM'); } catch (_) {}
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

function attachCardSessionWsListener(ws, cardSession, newCardWinHex) {
  if (!ws) return;
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.event === 'XBLOB_BROADCAST_V0' || msg.event === 'XBLOB_STREAM_CLOSED_V0') {
        cardSession.receivedBlobEvents.push(msg);
        logger.info(`Card ${newCardWinHex} received ${msg.event} for blob ${msg.blobId}`);
      } else {
        cardSession.receivedFrames.push(msg);
        logger.info(`Card ${newCardWinHex} received XChannel frame on txId=${msg.txId || msg.channel}: ${msg.event || msg.intent || 'frame'}`);
      }
    } catch (_) {}
  });
}

function launchCardBrowserWindow(cardUrl, newCardWinHex) {
  const customCmd = process.env.XHTML_BROWSER_CMD;
  if (customCmd === 'none' || customCmd === 'false' || customCmd === '0') {
    return null;
  }

  try {
    if (customCmd) {
      const proc = spawn(`${customCmd} "${cardUrl}"`, {
        shell: true,
        detached: true,
        env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: '1' },
        stdio: 'ignore',
      });
      proc.unref();
      logger.info(`Launched custom XHTML_BROWSER_CMD (${customCmd}) for ${cardUrl}`);
      return proc;
    }

    const firefoxBin = '/usr/bin/firefox';
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
      env: { ...process.env, MOZ_DISABLE_CONTENT_SANDBOX: '1' },
      stdio: 'ignore',
    });
    proc.unref();
    logger.info(`Launched Firefox (${args.join(' ')}) for card ${newCardWinHex}`);
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
  cardSession.browserProc = launchCardBrowserWindow(cardUrl, newCardWinHex);

  if (channel) {
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      senderWin: runtimeWin,
      channel,
      controlWord: 2, // FIN
      payload: {
        event: 'xhtml.LoadCardResponse',
        disposition: 'final',
        status: 'ok',
        cardApp,
        cardId,
        cardWin: newCardWinHex,
        cardUrl,
      },
    });
  }

  logger.info(`Completed xhtml.LoadCard for ${cardApp}/${cardId} -> cardWin=${newCardWinHex}`);
}

async function handleLiveMigrateIntent(X, root, runtimeWin, frame) {
  const { senderWin, payload, channel, dataBlob } = frame;
  const cardApp = payload.cardApp || payload.appId || 'xhtml-card';
  const cardId = payload.cardId || 'main';
  const cardEntry = payload.cardEntry || 'index.xhtml';
  const oldCardWin = parseWindowId(payload.oldCardWin || payload.cardWin) || senderWin;
  const stateBlobAtom = parseWindowId(dataBlob || payload.stateBlob || payload.blob);

  logger.info(
    `Received xhtml.LiveMigrate for ${cardApp}/${cardId} from oldCardWin=${xintent.widString(oldCardWin)} (stateBlob=${xintent.widString(stateBlobAtom)}, channel=${channel})`
  );

  // 1. Read the state snapshot blob
  let snapshot = {};
  if (stateBlobAtom) {
    try {
      const rawBlob = await xintent.XBlobRead(X, xintent.routerWin, stateBlobAtom);
      snapshot = extractSnapshotJson(rawBlob);
    } catch (err) {
      logger.error(`Failed to read state snapshot blob ${xintent.widString(stateBlobAtom)}:`, err.message);
    }
  }

  // 2. Allocate dedicated newCardWin on cool-http-bridge (or fallback to direct X11 window)
  const bridgeSession = await allocateBridgeCardSession(cardApp, cardId);
  let newCardWin = bridgeSession?.wid || 0;
  if (!newCardWin) {
    newCardWin = await xintent.createClientWindow(X, root, `${cardApp}:${cardId}`);
  }
  const newCardWinHex = xintent.widString(newCardWin);

  // 3. Re-attach open XChannels via WebSocket on cool-http-bridge BEFORE uncorking
  const reattachTxIds = (snapshot.openChannels || [])
    .map((ch) => Number(typeof ch === 'object' ? ch.txId : ch))
    .filter((n) => !isNaN(n) && n > 0);

  const ws = await connectCardRuntimeWebSocket(newCardWinHex, cardApp, cardId, reattachTxIds);
  const cardSession = {
    cardWin: newCardWin,
    cardWinHex: newCardWinHex,
    oldCardWin: xintent.widString(oldCardWin),
    cardApp,
    cardId,
    cardEntry,
    snapshot,
    ws,
    receivedFrames: [],
    receivedBlobEvents: [],
    migratedAt: Date.now(),
  };
  activeCards.set(newCardWinHex, cardSession);
  attachCardSessionWsListener(ws, cardSession, newCardWinHex);

  // 4. Atomically migrate XBlob grants/soft-links & open XChannels from oldCardWin to newCardWin and uncork
  if (oldCardWin && newCardWin && oldCardWin !== newCardWin) {
    await xintent.XHtmlMigrateWindow(X, xintent.routerWin, runtimeWin, oldCardWin, newCardWin);
    logger.info(`Executed XHTML_MIGRATE_WINDOW_V0: ${xintent.widString(oldCardWin)} -> ${newCardWinHex}`);
  }

  // 5. Transfer state snapshot blob ownership to newCardWin so the browser can read & unlink ?hydrateBlob=0x...
  if (stateBlobAtom) {
    try {
      if (newCardWin) {
        await xintent.XBlobGrant(X, xintent.routerWin, runtimeWin, stateBlobAtom, newCardWin);
      }
      await xintent.XBlobUnlink(X, xintent.routerWin, runtimeWin, stateBlobAtom);
    } catch (_) {}
  }

  // 5b. Spawn desktop browser window (defaults to /usr/bin/firefox) pointing to hydrated card URL
  const cardUrl = `${HTTP_BASE_URL}/apps/${encodeURIComponent(cardApp)}/${encodeURIComponent(cardId)}?cardWin=${encodeURIComponent(newCardWinHex)}&cardId=${encodeURIComponent(cardId)}${stateBlobAtom ? `&hydrateBlob=${encodeURIComponent(xintent.widString(stateBlobAtom))}` : ''}`;
  cardSession.browserProc = launchCardBrowserWindow(cardUrl, newCardWinHex);

  // 6. Acknowledge migration completion to oldCardWin (FIN)
  await xintent.sendXIntentEventV0(X, xintent.routerWin, {
    senderWin: runtimeWin,
    channel,
    controlWord: 2, // FIN
    payload: {
      event: 'xhtml.LiveMigrateResponse',
      disposition: 'final',
      status: 'ok',
      cardApp,
      cardId,
      cardEntry,
      oldCardWin: xintent.widString(oldCardWin),
      newCardWin: newCardWinHex,
      hydratedState: {
        localStorageKeys: Object.keys(snapshot.localStorage || {}),
        heldBlobs: snapshot.heldBlobs || [],
        softLinkedBlobs: snapshot.softLinkedBlobs || [],
        reattachedTxIds: reattachTxIds,
      },
    },
  });

  logger.info(`Completed xhtml.LiveMigrate for ${cardApp}/${cardId} -> newCardWin=${newCardWinHex}`);
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
    if (ev.type === 33 && ev.message_type === xintent.atoms.XINTENT_INTENT_V0) {
      try {
        const frame = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
        const intentName = frame.payload?.intent || frame.payload?.action;
        if (intentName === 'xhtml.LiveMigrate') {
          await handleLiveMigrateIntent(X, root, runtimeWin, frame);
        } else if (intentName === 'xhtml.LoadCard' || intentName === 'fs.Open') {
          await handleLoadCardIntent(X, root, runtimeWin, frame);
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
