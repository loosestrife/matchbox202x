const { on } = require('node:events');
const TOML = require('@iarna/toml');
const { Logger, HttpError, alStorage } = require('../server-tools');
const xintent = require('../x11-promises/xintent');
const server = require('./server-globals');
const logger = new Logger({ module: 'route-intent' });
const activeHttpAudioStreams = new Map();
let clientWin, X, root;

/**
 * Reads the aggregated TOML property off routerWin
 */
const fetchAggregateToml = async () => {
  const targetWin = xintent.routerWin;
  const atom = xintent.atoms.AGGREGATE_TOML || xintent.atoms.XINTENT_AGGREGATE_TOML;

  try {
    logger.info('tryna get AGGREGATE_TOML');
    const prop = await X.GetProperty(0, targetWin, atom, 0, 0, 1000000);
    if (prop && prop.data && prop.data.length > 0) {
      return prop.data.toString('utf8');
    }
  } catch (err) {
    logger.error(`[AGGREGATE TOML] Failed to fetch aggregate property: ${err.message}`);
  }
  return null;
};

/**
 * HTTP Handler to advertise available intents bus manifest
 * Supports returning raw TOML or parsed JSON based on headers/query parameters.
 */
const getAggregateToml = async (req, res) => {
  console.log('call to get aggregate toml');
  const rawToml = await fetchAggregateToml();

  if (!rawToml) {
    throw new HttpError(503, 'Aggregate intents manifest not available');
  }

  res.setHeader('Matchbox-Bridge', '1.0');

  const acceptHeader = req.headers.accept || '';
  if (
    req.query.format === 'toml' ||
    acceptHeader.includes('text/x-toml') ||
    acceptHeader.includes('application/toml')
  ) {
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
  const parsedManifest = TOML.parse(rawToml);
  return parsedManifest;
};

const routeIntent = async (req, res) => {
  const { namespace, action } = req.params;
  const intent = `${namespace}.${action}`;
  const payload = req.body || {};

  // If query string app is provided but missing from body payload, populate it
  if (req.query.app && !payload.app) {
    payload.app = req.query.app;
  }

  // If both query string app and body app are provided, enforce advisory match
  if (req.query.app && payload.app && req.query.app !== payload.app) {
    throw new HttpError(400, `advisory query string app specification (${req.query.app}) must match app specified in intent json (${payload.app}): ${JSON.stringify(payload)}`);
  }

  if (payload.intent && intent !== payload.intent) {
    throw new HttpError(400, `url path intent (${intent}) must match intent specified in intent json (${payload.intent}): ${JSON.stringify(payload)}`);
  }

  if (!payload.intent) {
    payload.intent = intent;
  }

  const targetApp = payload.app;

  const channelControlHeader = req.headers['x-channel-control'];
  const channelHeader = req.headers['x-channel'];
  const forwardedByHeader = req.headers['x-forwarded-by'];
  const logPayload = { ...payload };
  if (channelHeader) logPayload['X-Channel'] = channelHeader;
  if (channelControlHeader) logPayload['X-Channel-Control'] = channelControlHeader;
  if (forwardedByHeader) logPayload['X-Forwarded-By'] = forwardedByHeader;

  const preferReqHeader = (req.headers['prefer'] || '').toLowerCase();
  if (preferReqHeader.includes('return=minimal')) {
    payload.Prefer = 'return=minimal';
  }

  // Store intent context in AsyncLocalStorage so all error logs include the intent JSON
  logger.setContext({
    intent,
    targetApp: targetApp || undefined,
    intentJson: payload
  });

  logger.info(`[INTENT] ${intent}${targetApp ? ` -> Target: ${targetApp}` : ''}`, logPayload);
  const txId = server.getNextTxId();
  let reqControlWord = payload.controlWord;
  if (channelControlHeader) {
    let cw = 0;
    if (channelControlHeader.includes('SYN')) cw |= 1;
    if (channelControlHeader.includes('FIN')) cw |= 2;
    reqControlWord = cw;
  }
  if (reqControlWord !== undefined) {
    payload.controlWord = reqControlWord;
  }

  const hasChannelControl = Boolean(channelControlHeader) || reqControlWord !== undefined;
  const opensChannel = hasChannelControl || payload.Accept || req.headers['accept'];

  try {
    // --- 1. Streamed Multipart Response Path ---
    if (opensChannel) {
      let headersSent = false;
      const BOUNDARY = 'MatchboxFrameBoundary_' + Date.now().toString(16);

      const writeJsonFrame = (res, data, customHeaders = {}) => {
        if (res.writableEnded || res.finished) return;
        if (!headersSent) {
          res.writeHead(200, {
            // firefox bug: firefox doesnt stream response data of type multipart/mixed to apps
            'Content-Type': `multipart/mixed; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Connection': 'keep-alive',
            'X-Content-Type-Options': 'nosniff',
            'Matchbox-Bridge': '1.0',
          });
          headersSent = true;
        }
        const jsonBody = JSON.stringify(data, null, 2);
        const headers = [
          'Content-Type: application/json',
          'Content-Disposition: inline',
          `Content-Length: ${Buffer.byteLength(jsonBody)}`,
          ...Object.entries(customHeaders).map(([key, val]) => `${key}: ${val}`)
        ];

        res.write(`--${BOUNDARY}\r\n${headers.join('\r\n')}\r\n\r\n${jsonBody}\r\n\r\n`);
        if (typeof res.flush === 'function') {
          try { res.flush(); } catch (_) {}
        }
      };

      const writeXBlobFrame = (res, blobData, customHeaders = {}) => {
        if (res.writableEnded || res.finished) return;
        if (!headersSent) {
          res.writeHead(200, {
            'Content-Type': `multipart/mixed; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform, max-age=0',
            'Pragma': 'no-cache',
            'Expires': '0',
            'Connection': 'keep-alive',
            'X-Content-Type-Options': 'nosniff',
            'Matchbox-Bridge': '1.0',
          });
          headersSent = true;
        }

        const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'application/octet-stream');
        const dataType = blobData._dataType || (mimeType.includes('application/json') ? 'json' : 'binary');

        let bodyPayload = blobData.data !== undefined ? blobData.data : blobData;
        let bodyBuf;
        if (Buffer.isBuffer(bodyPayload)) {
          bodyBuf = bodyPayload;
        } else if (typeof bodyPayload === 'object') {
          bodyBuf = Buffer.from(JSON.stringify(bodyPayload), 'utf8');
        } else {
          bodyBuf = Buffer.from(String(bodyPayload), 'utf8');
        }

        const bodyLen = blobData.size !== undefined ? blobData.size : bodyBuf.length;

        const headers = [
          `Content-Type: ${mimeType}`,
          `Content-Length: ${bodyLen}`,
        ];

        if (dataType === 'base64') {
          headers.push('Content-Encoding: base64');
        }

        if (blobData.name) {
          headers.push(`Content-Disposition: attachment; filename="${blobData.name}"`);
        } else if (!mimeType.includes('application/json')) {
          headers.push('Content-Disposition: inline');
        }

        headers.push(`X-XBlob-Type: ${blobData.xblobType || 'Blob'}`);

        Object.entries(customHeaders).forEach(([key, val]) => {
          headers.push(`${key}: ${val}`);
        });

        const headerBuf = Buffer.from(`--${BOUNDARY}\r\n${headers.join('\r\n')}\r\n\r\n`, 'utf8');
        const footerBuf = Buffer.from('\r\n\r\n', 'utf8');

        res.write(Buffer.concat([headerBuf, bodyBuf, footerBuf]));
        if (typeof res.flush === 'function') {
          try { res.flush(); } catch (_) {}
        }
      };

      const responsePromise = new Promise((resolve) => {
        const handleMessageFromX = async (msg) => {
          if (res.writableEnded || res.finished) return;

          const eventData = msg?.payload || {};
          const controlWord = msg?.controlWord;
          const blobAtom = msg?.dataBlob || eventData?.data_blob || eventData?.blobId || eventData?.blob;

          logger.info(`route-intent: [HTTP STREAM] messageFromX XChannel ${txId}: ${xintent.frameDesc(msg)}`);

          if (typeof broadcastWsFrame === 'function' && eventData) {
            broadcastWsFrame(eventData);
          }

          const customIntentHeaders = {};
          if (blobAtom) {
            customIntentHeaders['X-Attached-Blob-Id'] = blobAtom;
          }
          if (controlWord !== undefined) {
            const ctrlStrings = [];
            if (controlWord & 1) ctrlStrings.push('SYN');
            if (controlWord & 2) ctrlStrings.push('FIN');
            if (ctrlStrings.length > 0) {
              customIntentHeaders['X-Channel-Control'] = ctrlStrings.join(',');
            }
          }

          writeJsonFrame(res, eventData, customIntentHeaders);

          const preferVal = String(eventData?.Prefer || payload?.Prefer || req.headers['prefer'] || '').toLowerCase();
          const isMinimalPreferred = preferVal.includes('return=minimal') || payload?.receive_data === false || payload?.receiveData === false;

          if (blobAtom && !isMinimalPreferred && !res.writableEnded && !res.finished) {
            try {
              const routerWin = await xintent.getValidRouterWin(X, root);
              const blob = await xintent.XBlobRead(X, routerWin, blobAtom);
              if (blob && !res.writableEnded && !res.finished) {
                writeXBlobFrame(res, blob, { 'X-Blob-Id': blobAtom });
              }
            } catch (err) {
              logger.error(`[BLOB READ ERROR] Failed to fetch blob atom ${blobAtom} for intent ${intent}: ${err.message}`, { intentPayload: payload });
            }
          }

          // Finalize stream when FIN control word received
          const isFin = controlWord !== undefined ? (controlWord & 2) !== 0 : false;

          if (isFin && !res.writableEnded && !res.finished) {
            logger.info("Closing HTTP stream (FIN received)", { txId, controlWord });
            if (headersSent) {
              res.write(`--${BOUNDARY}--\r\n`);
              res.end();
            } else {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(eventData));
            }
            const cookieKey = eventData?.cookie || eventData?.OutputId;
            if (cookieKey) {
              activeHttpAudioStreams.delete(cookieKey);
            }
            delete server.channelNatTable[txId];
            resolve();
          }
        };

        const sessionObj = {
          txId,
          type: 'http',
          res,
          intent,
          cookie: payload.cookie || payload.OutputId,
          controlWord: reqControlWord,
          createdAt: Date.now(),
          messageFromX: handleMessageFromX,
          writeFrame: handleMessageFromX,
        };
        server.channelNatTable[txId] = sessionObj;

        res.on('close', () => {
          if (!res.writableEnded && !res.finished) {
            logger.info(`[HTTP STREAM ABORTED] Client closed connection prematurely for txId ${txId}`);
            if (server.channelNatTable[txId]) {
              delete server.channelNatTable[txId];
            }
            resolve();
          }
        });
      });

      const reqDataBlob = payload.dataBlob || payload.sample || payload.blob || payload.blobId || payload.BlobId;
      const isXAudioPlay = intent.startsWith("xaudio.Play") || intent === "XAudioPlay" || intent === "XAudioPlayV0";
      const isXAudioControl = intent.startsWith("xaudio.Control") || intent === "XAudioControl" || intent === "XAudioControlV0";
      const cookie = payload.cookie || payload.Cookie || payload.OutputId || 'default';
      const streamId = payload.streamId !== undefined ? Number(payload.streamId) : 0;
      const isAudioStream = (streamId > 0 || payload.streamId) && isXAudioPlay;

      const dispatchFn = isXAudioPlay
        ? (xintent.sendXAudioPlayV0 || xintent.sendXIntentIntentV0)
        : (isXAudioControl ? (xintent.sendXAudioControlV0 || xintent.sendXIntentIntentV0) : xintent.sendXIntentIntentV0);

      // Fast-path for subsequent audio stream chunk requests: queue on X11 bus, return 202 Accepted, and close connection
      if (isAudioStream && activeHttpAudioStreams.has(cookie)) {
        const primarySession = activeHttpAudioStreams.get(cookie);
        logger.info(`route-intent: [XAUDIO STREAM] Active primary stream connection exists for cookie '${cookie}'. Forwarding seqnum ${payload.seqnum} on primary txId ${primarySession.txId} and returning 202 Accepted.`);

        const routerWin = await xintent.getValidRouterWin(X, root);
        await dispatchFn(X, routerWin, {
          senderWin: clientWin,
          payload,
          txId: primarySession.txId,
          controlWord: reqControlWord,
          dataBlob: reqDataBlob ? Number(reqDataBlob) : 0,
        });

        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 202, message: 'Queued for playback', cookie, seqnum: payload.seqnum }));
        return;
      }

      if (isAudioStream) {
        activeHttpAudioStreams.set(cookie, { res, txId });
      }

      const routerWin = await xintent.getValidRouterWin(X, root);
      await dispatchFn(X, routerWin, {
        senderWin: clientWin,
        payload,
        txId,
        controlWord: reqControlWord,
        dataBlob: reqDataBlob ? Number(reqDataBlob) : 0,
      });

      return await responsePromise;
    }

    // --- 2. Fire-and-Forget / Standard Response Path ---
    const reqDataBlob = payload.dataBlob || payload.sample || payload.blob || payload.blobId || payload.BlobId;
    const isXAudioPlay = intent.startsWith("xaudio.Play") || intent === "XAudioPlay" || intent === "XAudioPlayV0";
    const isXAudioControl = intent.startsWith("xaudio.Control") || intent === "XAudioControl" || intent === "XAudioControlV0";
    const dispatchFn = isXAudioPlay
      ? (xintent.sendXAudioPlayV0 || xintent.sendXIntentIntentV0)
      : (isXAudioControl ? (xintent.sendXAudioControlV0 || xintent.sendXIntentIntentV0) : xintent.sendXIntentIntentV0);

    await dispatchFn(X, xintent.routerWin, {
      senderWin: clientWin,
      payload,
      txId,
      controlWord: reqControlWord,
      dataBlob: reqDataBlob ? Number(reqDataBlob) : 0,
    });

    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', intent, targetApp });
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


let broadcastWsFrame = null;

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
  };
};
