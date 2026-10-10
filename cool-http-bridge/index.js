const path = require('path');
const express = require('express');
const {serializeError} = require('serialize-error');
const {HttpError, Logger, loggerMiddleware, alStorage, nnjsonStream, teeOutStream} = require('../server-tools');
const { createClientWithPromises } = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');

(async () => {
xintent.init({logger: new Logger({module: 'libxintent'})});
const logger = new Logger({module: 'index.js'});
logger.setProjectName('cool-http-bridge');
const { X, root } = await createClientWithPromises();
await xintent.connectToRouter(X, root);
const clientWin = await xintent.createClientWindow(X, root, 'http-intent-bridge');
const wsClients = new Set();
const broadcastWsFrame = (data) => {
  if (!data) return;
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(jsonStr); } catch (_) {}
    }
  }
};

const { routeIntent, aggregateTomlAsObject } = require('./route-intent')({ X, root, clientWin, broadcastWsFrame });
const { routeApp, getApps } = require('./route-app');
const {
  routeXBlobCreate,
  routeXBlobRead,
  routeXBlobTransfer,
  routeXBlobGrant,
  routeXBlobUnlink,
  routeXBlobBroadcast,
} = require('./route-xblob')({ X, clientWin });

const app = express();
app.set("json spaces", 2);
app.use(express.json({ type: ['application/json', 'application/*+json', 'text/*', '*/*'] }));
app.use(express.text({ type: '*/*' }));
app.use((req, res, next) => {
  if (typeof req.body === 'string' && req.body.trim()) {
    try {
      req.body = JSON.parse(req.body);
    } catch (_) {
      req.body = { text: req.body };
    }
  }
  next();
});
app.use(loggerMiddleware);
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.post('/intent/:namespace/:action', routeIntent);
app.post('/xblob/XBlobCreate', routeXBlobCreate);
app.post('/xblob/XBlobRead', routeXBlobRead);
app.get('/xblob/:blobId', routeXBlobRead);
app.post('/xblob/XBlobTransfer', routeXBlobTransfer);
app.post('/xblob/XBlobGrant', routeXBlobGrant);
app.post('/xblob/XBlobUnlink', routeXBlobUnlink);
app.post('/xblob/XBlobBroadcast', routeXBlobBroadcast);
const serveFavicon = (req, res) => {
  res.sendFile(path.join(__dirname, 'assets', 'favicon.ico'));
};

app.get('/favicon.ico', serveFavicon);
app.get('/apps/favicon.ico', serveFavicon);
app.get('/matchbox202x.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'assets', 'matchbox202x.js'));
});
app.get('/apps/:app{/:card}', routeApp);
app.get('/api/tags', async (req, res) => {
  res.json({
    ...await aggregateTomlAsObject(),
    apps: getApps(),
  });
});
app.get('/api/debug/xaudio', (req, res) => {
  res.json({
    activeStreams: getActiveAudioStreams(),
    activeXChannels: Object.entries(serverGlobals.channelNatTable).map(([txId, session]) => ({
      txId: Number(txId),
      type: session.type || (session.ws ? 'websocket' : 'http'),
      xaudioSink: session.xaudioSink || null,
      intent: session.intent || null,
      cookie: session.cookie || null,
      controlWord: session.controlWord || null,
      createdAt: session.createdAt || null,
    })),
  });
});

app.use((err, req, res, next) => {
  const status = err.httpCode || 500;
  const level = status < 500 ? 'info' : 'error';
  const store = alStorage.getStore();
  const intentPayload = store?.values?.intentJson || req.body;

  logger[level](
    `[HTTP BRIDGE ERROR ${status}] ${err.message || err}`,
    err.stack || err,
    intentPayload ? { intentPayload } : {}
  );

  if (res.headersSent) {
    return next(err);
  }

  res.status(status).json(serializeError(err));
});

const http = require('http');
const WebSocket = require('ws');

const serverGlobals = require('./server-globals');

function formatMessageHttp(payload, blobData, txId, controlWord) {
  const jsonBody = JSON.stringify(payload, null, 2);
  const boundary = 'MatchboxFrameBoundary_' + Date.now().toString(16);

  if (!blobData) {
    const headers = [
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(jsonBody)}`,
      `X-Tx-Id: ${txId}`,
    ];
    if (controlWord !== undefined) {
      headers.push(`X-Channel-Control: ${controlWord & 2 ? 'FIN' : 'SYN'}`);
    }
    return headers.join('\r\n') + '\r\n\r\n' + jsonBody;
  }

  const mimeType = blobData.type || 'application/octet-stream';
  let bodyBuf = Buffer.isBuffer(blobData.data)
    ? blobData.data
    : Buffer.from(typeof blobData.data === 'object' ? JSON.stringify(blobData.data) : String(blobData.data || ''), 'utf8');

  const part1Header = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(jsonBody)}\r\nX-Tx-Id: ${txId}`;
  const part2Header = `Content-Type: ${mimeType}\r\nContent-Length: ${bodyBuf.length}\r\nX-XBlob-Type: ${blobData.xblobType || 'Blob'}`;

  const headerBuf = Buffer.from(
    `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n` +
    `--${boundary}\r\n${part1Header}\r\n\r\n${jsonBody}\r\n\r\n` +
    `--${boundary}\r\n${part2Header}\r\n\r\n`,
    'utf8'
  );
  const footerBuf = Buffer.from(`\r\n\r\n--${boundary}--\r\n`, 'utf8');

  return Buffer.concat([headerBuf, bodyBuf, footerBuf]);
}

function createWebSocketXChannel(txId, ws, xaudioSink, msgPayload, controlWord) {
  return {
    txId,
    type: 'websocket',
    ws,
    xaudioSink: xaudioSink || ws.xaudioSink || msgPayload?.app,
    intent: msgPayload?.intent,
    cookie: msgPayload?.cookie || msgPayload?.OutputId,
    controlWord: controlWord || 1,
    createdAt: Date.now(),
    messageFromX: async (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        let blobData = null;
        const shouldReceiveData = msgPayload?.receive_data !== false &&
          msgPayload?.receiveData !== false &&
          msgPayload?.fetch_data !== false &&
          msgPayload?.fetch_blob !== false &&
          msgPayload?.fetchData !== false &&
          msgPayload?.fetchBlob !== false;

        if (msg.dataBlob && shouldReceiveData) {
          try {
            const routerWin = await xintent.getValidRouterWin(X, root);
            blobData = await xintent.XBlobRead(X, routerWin, msg.dataBlob);
          } catch (err) {
            logger.error(`Error reading dataBlob ${msg.dataBlob} for WebSocket channel ${txId}: ${err.message}`);
          }
        }

        if (ws.isMessageHttp || ws.protocol === 'message/http') {
          const httpMsg = formatMessageHttp(msg.payload || {}, blobData, txId, msg.controlWord);
          ws.send(httpMsg);
        } else {
          const responseFrame = {
            txId,
            controlWord: msg.controlWord,
            ...msg.payload,
            ...(blobData ? { blob: blobData } : {}),
          };
          ws.send(JSON.stringify(responseFrame));
        }
        logger.info(`WebSocket XChannel ${txId} routed messageFromX: ${xintent.frameDesc(msg)}`);
      }

      const isFin = msg.controlWord !== undefined ? (msg.controlWord & 2) !== 0 : false;
      if (isFin) {
        logger.info(`Closing WebSocket XChannel ${txId} on FIN`);
        delete serverGlobals.channelNatTable[txId];
        if (ws.isXAudio) {
          try { ws.close(); } catch (_) {}
        }
      }
    }
  };
}

// Single Central X11 Event Dispatcher for cool-http-bridge
X.on('event', async (ev) => {
  if (!ev || ev.type !== 33) return;

  const responseAtoms = [
    xintent.atoms.XINTENT_INTENT_V0,
    xintent.atoms.XINTENT_EVENT_V0,
    xintent.atoms.XAUDIO_PLAY_V0,
    xintent.atoms.XAUDIO_PLAY_RESPONSE_V0,
    xintent.atoms.XAUDIO_CONTROL_V0,
  ].filter(Boolean);

  if (!responseAtoms.includes(ev.message_type)) return;

  try {
    const routerWin = await xintent.getValidRouterWin(X, root);
    const parsed = await xintent.parseXIntentIntentV0(X, routerWin, ev);
    const { channel: txId, controlWord, payload } = parsed;

    if (!txId) return;

    let session = serverGlobals.channelNatTable[txId];

    // If incoming X11 command for a remote WebSocket sink not yet in channelNatTable
    if (!session && (ev.message_type === xintent.atoms.XAUDIO_PLAY_V0 || ev.message_type === xintent.atoms.XINTENT_INTENT_V0)) {
      const targetSink = payload.app || payload.XAudioSink || payload.sink || 'flammenwerfer-phone';
      let targetWs = null;

      for (const ws of wsClients) {
        if (ws.readyState === WebSocket.OPEN && (ws.xaudioSink === targetSink || ws.appName === targetSink)) {
          targetWs = ws;
          break;
        }
      }

      if (targetWs) {
        session = createWebSocketXChannel(txId, targetWs, targetSink, payload, controlWord);
        serverGlobals.channelNatTable[txId] = session;
      }
    }

    if (session && typeof session.messageFromX === 'function') {
      await session.messageFromX(parsed);
    } else {
      logger.info(`Ignored packet on closed/inactive XChannel ${txId}: ${xintent.frameDesc(parsed)}`);
    }
  } catch (err) {
    logger.error(`Error in central X11 event dispatcher on clientWin: ${err.message}`);
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({
  noServer: true,
  handleProtocols: (protocols) => {
    if (protocols && protocols.has && protocols.has('message/http')) return 'message/http';
    if (protocols && Array.isArray(protocols) && protocols.includes('message/http')) return 'message/http';
    return false;
  }
});

wss.on('connection', (ws, request) => {
  const sinkParam = ws.xaudioSink;
  if (ws.isXAudio || sinkParam) {
    logger.info(`Remote XAudio WebSocket client connected (XAudioSink: ${sinkParam || 'default'})`);
  } else {
    logger.info('Remote WebSocket client connected');
  }
  wsClients.add(ws);

  ws.on('message', async (data) => {
    try {
      let msg = null;
      const dataStr = data.toString('utf8');
      if (dataStr.includes('Content-Type:') || dataStr.includes('MatchboxFrameBoundary')) {
        const parsedBlob = xintent.parseXBlobAtRest(data);
        msg = (parsedBlob && typeof parsedBlob.data === 'object') ? parsedBlob.data : parsedBlob;
      } else {
        msg = JSON.parse(dataStr);
      }

      if (!ws.isXAudio) {
         logger.info('Remote WebSocket message received:', msg);
      }

      if (msg.event === 'sys.Advertise' || msg.intent === 'sys.Advertise') {
        const appName = msg.app || 'flammenwerfer-phone';
        ws.appName = appName;
        if (msg.manifest) {
          if (msg.manifest.includes('XAudioSink')) {
            const match = msg.manifest.match(/\[XAudioSink\]\s*\n\s*name\s*=\s*"([^"]+)"/);
            if (match && match[1]) {
              ws.xaudioSink = match[1];
            } else {
              ws.xaudioSink = appName;
            }
          }
          await X.ChangeProperty(
            0,
            clientWin,
            xintent.atoms.MATCHBOX_TOML,
            xintent.atoms.STRING,
            8,
            Buffer.from(msg.manifest, 'utf8')
          );
          await xintent.getAllMatchboxToml();
          logger.info(`Registered MATCHBOX_TOML manifest for '${appName}' (XAudioSink: ${ws.xaudioSink})`);
        }
      } else if (msg.event === 'XAudioPlayResponseV0' || msg.intent === 'XAudioPlayResponseV0') {
        const txId = msg.txId || msg.channel;
        if (txId) {
          const routerWin = await xintent.getValidRouterWin(X, root);
          const sendResponseFn = xintent.sendXAudioPlayResponseV0 || xintent.sendXIntentEventV0;

          await sendResponseFn(X, routerWin, {
            senderWin: clientWin,
            txId,
            controlWord: msg.controlWord || 1,
            payload: msg,
          });

          if ((msg.controlWord & 2) !== 0) {
            delete serverGlobals.channelNatTable[txId];
          }
        }
      } else if (msg.intent) {
        const routerWin = await xintent.getValidRouterWin(X, root);
        const isXAudio = msg.intent.startsWith('xaudio.') || msg.intent.startsWith('XAudio');

        ws.activeAudioTxIds = ws.activeAudioTxIds || {};
        const audioKey = msg.cookie || msg.OutputId || 'default';
        let txId = msg.txId;

        if (!txId && isXAudio && ws.activeAudioTxIds[audioKey]) {
          txId = ws.activeAudioTxIds[audioKey];
        }

        if (!txId || !serverGlobals.channelNatTable[txId]) {
          txId = txId || serverGlobals.getNextTxId();
          serverGlobals.channelNatTable[txId] = createWebSocketXChannel(
            txId,
            ws,
            ws.xaudioSink || msg.app,
            msg,
            msg.controlWord || 1
          );
          if (isXAudio) {
            ws.activeAudioTxIds[audioKey] = txId;
          }
        }

        msg.txId = txId;

        const dispatchFn = isXAudio
          ? (xintent.sendXAudioPlayV0 || xintent.sendXIntentIntentV0)
          : xintent.sendXIntentIntentV0;
        const reqDataBlob = msg.dataBlob || msg.sample || msg.blob || msg.blobId || msg.BlobId;

        await dispatchFn(X, routerWin, {
          senderWin: clientWin,
          payload: msg,
          txId,
          controlWord: msg.controlWord || 1,
          dataBlob: reqDataBlob ? Number(reqDataBlob) : 0,
        });

        if (isXAudio && (msg.controlWord & 2) !== 0) {
          delete ws.activeAudioTxIds[audioKey];
        }
      }
    } catch (err) {
      logger.error('Remote WebSocket message error:', err.message);
    }
  });

  ws.on('close', async () => {
    logger.info(`WebSocket client disconnected (XAudioSink: ${ws.xaudioSink || ws.appName || 'none'})`);
    wsClients.delete(ws);

    for (const [txIdStr, session] of Object.entries(serverGlobals.channelNatTable)) {
      if (session.ws === ws) {
        const txId = Number(txIdStr);
        logger.info(`Closing XChannel ${txId} on WebSocket disconnect`);
        delete serverGlobals.channelNatTable[txId];

        try {
          const routerWin = await xintent.getValidRouterWin(X, root);
          if (routerWin) {
            await xintent.sendXIntentEventV0(X, routerWin, {
              targetWin: routerWin,
              senderWin: clientWin,
              txId,
              controlWord: 2, // FIN
              payload: {
                event: 'http.502',
                message: 'Connection reset by peer.',
                status: 502,
                controlWord: 2,
              },
            });
          }
        } catch (_) {}
      }
    }
  });
});

server.on('upgrade', (request, socket, head) => {
  try {
    const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
    const pathname = parsedUrl.pathname;
    if (pathname === '/ws' || pathname === '/remote-intents' || pathname === '/xaudio') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.xaudioSink = parsedUrl.searchParams.get('XAudioSink') || parsedUrl.searchParams.get('app');
        if (pathname === '/xaudio' || ws.xaudioSink) {
          ws.isXAudio = true;
        }
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch (_) {
    socket.destroy();
  }
});

server.listen(12345, '0.0.0.0', () => {
  logger.info('matchbox202x intent server running on http://0.0.0.0:12345 (WebSocket: ws://0.0.0.0:12345/ws)');
});
})()
