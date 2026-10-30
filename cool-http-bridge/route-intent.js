const TOML = require('@iarna/toml');
const { Logger } = require('../server-tools');
const xintent = require('../x11-promises/xintent');
const server = require('./server-globals');
const helpers = require('./intent-helpers');

const logger = new Logger({ module: 'route-intent' });
const activeHttpAudioStreams = new Map();
let clientWin, X, root, broadcastWsFrame;

async function ensureAggregateTomlAtom() {
  let atom = xintent.atoms.AGGREGATE_TOML || xintent.atoms.XINTENT_AGGREGATE_TOML;
  if (!atom && X) {
    try {
      atom = await X.InternAtom(false, 'AGGREGATE_TOML');
      xintent.atoms.AGGREGATE_TOML = atom;
    } catch (_) {}
  }
  return atom;
}

const fetchAggregateToml = async () => {
  const targetWin = xintent.routerWin || (X && root ? await xintent.getValidRouterWin(X, root) : null);
  const atom = targetWin ? await ensureAggregateTomlAtom() : null;
  if (!targetWin || !atom) return null;

  try {
    const prop = await X.GetProperty(0, targetWin, atom, 0, 0, 1000000);
    if (prop && prop.data && prop.data.length > 0) {
      const rawToml = prop.data.toString('utf8');
      logger.info(`[AGGREGATE TOML] Raw aggregate TOML:\n${rawToml}`);
      return rawToml;
    }
  } catch (err) {
    logger.error(`[AGGREGATE TOML] Failed to fetch aggregate property: ${err.message}`);
  }
  return null;
};

function wantsRawToml(req) {
  const acceptHeader = req.headers.accept || '';
  return (
    req.query.format === 'toml' ||
    acceptHeader.includes('text/x-toml') ||
    acceptHeader.includes('application/toml')
  );
}

const getAggregateToml = async (req, res) => {
  logger.info('Call to get aggregate TOML');
  const rawToml = await fetchAggregateToml();
  res.setHeader('Matchbox-Bridge', '1.0');

  if (!rawToml) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ intents: {} });
  }

  if (wantsRawToml(req)) {
    res.setHeader('Content-Type', 'text/x-toml; charset=utf-8');
    return res.status(200).send(rawToml);
  }

  try {
    const parsedManifest = TOML.parse(rawToml);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(parsedManifest);
  } catch (err) {
    logger.error(`[AGGREGATE TOML] Failed to parse aggregate TOML string: ${err.message}`);
    res.setHeader('Content-Type', 'text/x-toml; charset=utf-8');
    return res.status(200).send(rawToml);
  }
};

const aggregateTomlAsObject = async () => {
  const rawToml = await fetchAggregateToml();
  if (!rawToml) return { intents: {} };
  try {
    return TOML.parse(rawToml);
  } catch (err) {
    logger.error(`[AGGREGATE TOML] Failed to parse TOML string: ${err.message}`);
    return { intents: {} };
  }
};

const resolveDataBlob = async (rawBlob, XClient, rWin, cWin) => {
  if (!rawBlob) return 0;
  if (typeof rawBlob === 'number') return isNaN(rawBlob) ? 0 : rawBlob;
  if (typeof rawBlob === 'string') {
    const trimmed = rawBlob.trim();
    const num = (trimmed.startsWith('0x') || trimmed.startsWith('0X')) ? parseInt(trimmed, 16) : Number(trimmed);
    return isNaN(num) ? 0 : num;
  }
  if (typeof rawBlob === 'object') {
    try {
      return await xintent.XBlobCreate(XClient, rWin, cWin, rawBlob);
    } catch (err) {
      logger.error(`Failed to auto-create XBlob for inline object: ${err.message}`);
    }
  }
  return 0;
};

function wakeTargetDeviceIfNeeded(targetApp) {
  if (!targetApp) return;
  const deviceName = targetApp.includes(':') ? targetApp.split(':')[0] : targetApp;
  const knownIpOrHost = server.lastKnownDeviceIps[deviceName] || server.lastKnownDeviceIps[targetApp];
  const isIpAddress = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(deviceName);
  const hostToPing = knownIpOrHost || (isIpAddress ? deviceName : null);
  if (hostToPing && hostToPing !== 'localhost' && hostToPing !== '127.0.0.1') {
    server.sendUdpWakePing(hostToPing, 12346);
  }
}

function registerHttpStreamChannel({ req, res, senderWin, txId, intent, payload, reqControlWord }) {
  const state = { headersSent: false };
  const boundary = 'MatchboxFrameBoundary_' + Date.now().toString(16);

  return new Promise((resolve) => {
    const handleMessageFromX = helpers.createMessageFromXHandler({
      X,
      req,
      res,
      state,
      boundary,
      logger,
      senderWin,
      txId,
      intent,
      payload,
      broadcastWsFrame,
      activeHttpAudioStreams,
      channelNatTable: server.channelNatTable,
      deleteChannelSession: server.deleteChannelSession,
      resolve,
    });

    server.setChannelSession(senderWin, txId, {
      txId,
      cardWin: senderWin,
      type: 'http',
      res,
      intent,
      cookie: payload.cookie || payload.OutputId,
      controlWord: reqControlWord,
      createdAt: Date.now(),
      messageFromX: handleMessageFromX,
      writeFrame: handleMessageFromX,
    });

    res.on('close', () => {
      if (!res.writableEnded && !res.finished) {
        logger.info(`[HTTP STREAM ABORTED] Client closed connection prematurely for txId ${txId}`);
        server.deleteChannelSession(senderWin, txId);
        resolve();
      }
    });
  });
}

async function handleStreamedIntent({ req, res, senderWin, intent, payload, txId, reqControlWord }) {
  const responsePromise = registerHttpStreamChannel({ req, res, senderWin, txId, intent, payload, reqControlWord });
  const rawBlob = helpers.extractRawBlobRef(req, payload);
  const routerWin = await xintent.getValidRouterWin(X, root);
  const dataBlob = await resolveDataBlob(rawBlob, X, routerWin, senderWin);
  const dispatchFn = helpers.resolveIntentDispatchFn(intent);

  const isXAudioPlay = intent.startsWith('xaudio.Play') || intent === 'XAudioPlay' || intent === 'XAudioPlayV0';
  const cookie = payload.cookie || payload.Cookie || payload.OutputId || 'default';
  const streamId = payload.streamId !== undefined ? Number(payload.streamId) : 0;
  const isAudioStream = Boolean(streamId > 0 || payload.streamId) && isXAudioPlay;

  if (isAudioStream && activeHttpAudioStreams.has(cookie)) {
    const primarySession = activeHttpAudioStreams.get(cookie);
    logger.info(`route-intent: [XAUDIO STREAM] Active primary stream connection exists for cookie '${cookie}'. Forwarding seqnum ${payload.seqnum} on primary txId ${primarySession.txId} and returning 202 Accepted.`);
    await dispatchFn(X, routerWin, {
      senderWin,
      payload,
      txId: primarySession.txId,
      controlWord: reqControlWord,
      dataBlob,
    });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 202, message: 'Queued for playback', cookie, seqnum: payload.seqnum }));
    return;
  }

  if (isAudioStream) {
    activeHttpAudioStreams.set(cookie, { res, txId });
  }

  await dispatchFn(X, routerWin, {
    senderWin,
    payload,
    txId,
    controlWord: reqControlWord,
    dataBlob,
  });

  return await responsePromise;
}

const routeIntent = async (req, res) => {
  const { namespace, action } = req.params;
  const intent = `${namespace}.${action}`;
  const payload = helpers.validateAndNormalizeIntentPayload(req, intent);
  const targetApp = payload.app;
  const senderWin = server.parseWindowId(req.headers['x-card-window'] || payload.cardWin) || clientWin;

  const logPayload = helpers.buildIntentLogPayload(req, payload);
  helpers.applyRequestHeadersToPayload(req, payload);

  logger.setContext({ intent, targetApp: targetApp || undefined });
  logger.info(`[INTENT] ${intent}${targetApp ? ` -> Target: ${targetApp}` : ''}`, logPayload);
  wakeTargetDeviceIfNeeded(targetApp);

  const requestedTxId = Number(req.headers['x-tx-id'] || payload.txId || 0);
  const txId = (requestedTxId > 0 && requestedTxId < 16777216) ? requestedTxId : server.getNextTxId();
  server.advanceTxIdPast(txId);
  const { reqControlWord, opensChannel } = helpers.parseChannelControlOptions(req, payload);

  try {
    if (opensChannel) {
      return await handleStreamedIntent({ req, res, senderWin, intent, payload, txId, reqControlWord });
    }

    const rawBlob = helpers.extractRawBlobRef(req, payload);
    const routerWin = await xintent.getValidRouterWin(X, root);
    const dataBlob = await resolveDataBlob(rawBlob, X, routerWin, senderWin);
    const dispatchFn = helpers.resolveIntentDispatchFn(intent);

    await dispatchFn(X, routerWin, {
      senderWin,
      payload,
      txId,
      controlWord: reqControlWord,
      dataBlob,
    });

    res.setHeader('Matchbox-Bridge', '1.0');
    res.setHeader('X-Tx-Id', String(txId));
    res.status(200).json({ status: 'ok', intent, targetApp, txId });
  } catch (err) {
    logger.error(
      `[ROUTE INTENT ERROR] ${intent}${targetApp ? ` to ${targetApp}` : ''} failed: ${err.message}`,
      err.stack || err,
      { intentPayload: payload }
    );
    throw err;
  }
};

const getActiveAudioStreams = () => {
  const streams = [];
  for (const [cookie, session] of activeHttpAudioStreams.entries()) {
    streams.push({ cookie, txId: session.txId });
  }
  return streams;
};

module.exports = ({ X: xClient, root: xRoot, clientWin: theClientWin, broadcastWsFrame: theBroadcastWsFrame }) => {
  X = xClient;
  root = xRoot;
  clientWin = theClientWin;
  broadcastWsFrame = theBroadcastWsFrame;

  return {
    routeIntent,
    getAggregateToml,
    fetchAggregateToml,
    aggregateTomlAsObject,
    getActiveAudioStreams,
  };
};
