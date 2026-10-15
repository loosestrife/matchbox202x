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
app.get('/blobs/:blobId', routeXBlobRead);
app.post('/xblob/XBlobTransfer', routeXBlobTransfer);
app.post('/xblob/XBlobGrant', routeXBlobGrant);
app.post('/xblob/XBlobUnlink', routeXBlobUnlink);
app.delete('/xblob/XBlobUnlink', routeXBlobUnlink);
app.delete('/blobs/:blobId', routeXBlobUnlink);
app.delete('/xblob/:blobId', routeXBlobUnlink);
app.delete('/xblob', routeXBlobUnlink);
app.post('/xblob/XBlobBroadcast', routeXBlobBroadcast);
app.post('/blobs/:blobId/broadcast', routeXBlobBroadcast);
app.post('/xblob/:blobId/broadcast', routeXBlobBroadcast);
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
app.get(['/apps/:app', '/apps/:app/*path'], routeApp);
app.get('/api/tags', async (req, res) => {
  res.json({
    ...await aggregateTomlAsObject(),
    apps: getApps(),
  });
});
app.get('/api/debug/xaudio', (req, res) => {
  res.json({
    activeStreams: getActiveAudioStreams(),
    deviceProxyWindows: serverGlobals.deviceProxyWindows,
    proxyWindowToDevice: serverGlobals.proxyWindowToDevice,
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
      } else {
        // WebSocket connection dropped or inactive: send UDP wake ping if target device is a known remote IP/host
        const deviceName = targetSink.includes(':') ? targetSink.split(':')[0] : targetSink;
        const knownIpOrHost = serverGlobals.lastKnownDeviceIps[deviceName] || serverGlobals.lastKnownDeviceIps[targetSink];
        const isIpAddress = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(deviceName);
        const hostOrIp = knownIpOrHost || (isIpAddress ? deviceName : null);
        if (hostOrIp && hostOrIp !== 'localhost' && hostOrIp !== '127.0.0.1') {
          logger.info(`[UDP 🔔] Target WebSocket '${targetSink}' inactive. Sending UDP wake ping to ${hostOrIp}:12346...`);
          serverGlobals.sendUdpWakePing(hostOrIp, 12346);
        }
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
  handleProtocols: (protocols, req) => {
    const list = protocols ? (Array.isArray(protocols) ? protocols : Array.from(protocols)) : [];
    logger.info(`[handleProtocols] Negotiating subprotocols for ${req?.url}: ${JSON.stringify(list)}`);
    for (const p of list) {
      if (typeof p === 'string' && (p.trim() === 'message-http' || p.trim() === 'message/http')) return p;
    }
    return list[0] || false;
  }
});

wss.on('wsClientError', (err, socket, request) => {
  const url = request?.url || 'unknown';
  const clientIp = request?.socket?.remoteAddress ? request.socket.remoteAddress.replace(/^.*:/, '') : 'unknown';
  const errMsg = err?.message || 'WebSocket upgrade failed';
  const headersJson = JSON.stringify(request?.headers || {});

  logger.warn(`[WebSocket 400] Rejected upgrade request from ${clientIp} on ${url}: ${errMsg} Headers: ${headersJson}`);

  if (socket.writable) {
    const body = String(errMsg);
    const response =
      `HTTP/1.1 400 Bad Request\r\n` +
      `Connection: close\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body;
    try { socket.write(response); } catch (_) {}
  }
  try { socket.destroy(); } catch (_) {}
});

wss.on('connection', (ws, request) => {
  const clientIp = request?.socket?.remoteAddress ? request.socket.remoteAddress.replace(/^.*:/, '') : null;
  if (clientIp) {
    ws.clientIp = clientIp;
    if (ws.xaudioSink) serverGlobals.lastKnownDeviceIps[ws.xaudioSink] = clientIp;
  }

  const sinkParam = ws.xaudioSink;
  if (ws.isXAudio || sinkParam) {
    logger.info(`Remote XAudio WebSocket client connected (XAudioSink: ${sinkParam || 'default'}, IP: ${clientIp || 'unknown'})`);
  } else {
    logger.info(`Remote WebSocket client connected (IP: ${clientIp || 'unknown'})`);
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
        if (ws.clientIp) {
          serverGlobals.lastKnownDeviceIps[appName] = ws.clientIp;
        }
        if (msg.manifest) {
          if (msg.manifest.includes('XAudioSink')) {
            const match = msg.manifest.match(/\[XAudioSink\]\s*\n\s*name\s*=\s*"([^"]+)"/);
            if (match && match[1]) {
              ws.xaudioSink = match[1];
            } else {
              ws.xaudioSink = appName;
            }
          }
          if (ws.clientIp && ws.xaudioSink) {
            serverGlobals.lastKnownDeviceIps[ws.xaudioSink] = ws.clientIp;
          }
          // Reuse existing proxy window if preserved during idle disconnect
          const existingRecord = serverGlobals.deviceProxyWindows[appName];
          if (!ws.proxyWin) {
            if (existingRecord && existingRecord.wid) {
              ws.proxyWin = existingRecord.wid;
              logger.info(`Re-attached existing proxy X11 window ${xintent.widString(ws.proxyWin)} for '${appName}'`);
            } else {
              ws.proxyWin = await xintent.createClientWindow(X, root, appName);
              logger.info(`Allocated dedicated proxy X11 window ${xintent.widString(ws.proxyWin)} for '${appName}'`);
            }
          }

          const widHex = xintent.widString(ws.proxyWin);
          const deviceRecord = {
            wid: ws.proxyWin,
            widHex,
            appName,
            xaudioSink: ws.xaudioSink || appName,
            clientIp: ws.clientIp || null,
            updatedAt: Date.now(),
          };
          serverGlobals.deviceProxyWindows[appName] = deviceRecord;
          if (ws.xaudioSink) {
            serverGlobals.deviceProxyWindows[ws.xaudioSink] = deviceRecord;
          }
          serverGlobals.proxyWindowToDevice[widHex] = appName;

          await X.ChangeProperty(
            0,
            ws.proxyWin,
            xintent.atoms.MATCHBOX_TOML,
            xintent.atoms.STRING,
            8,
            Buffer.from(msg.manifest, 'utf8')
          );
          logger.info(`Registered MATCHBOX_TOML raw manifest on proxy window ${widHex} for '${appName}' (XAudioSink: ${ws.xaudioSink}):\n${msg.manifest}`);
        }
      } else if (msg.event === 'sys.Deadvertise' || msg.intent === 'sys.Deadvertise') {
        const appName = msg.app || ws.appName || 'user-phone:flammenwerfer';
        logger.info(`Received sys.Deadvertise for '${appName}'`);
        ws.explicitDeadvertise = true;
        if (ws.proxyWin) {
          const widHex = xintent.widString(ws.proxyWin);
          delete serverGlobals.proxyWindowToDevice[widHex];
          if (appName) delete serverGlobals.deviceProxyWindows[appName];
          if (ws.xaudioSink) delete serverGlobals.deviceProxyWindows[ws.xaudioSink];

          try {
            X.DestroyWindow(ws.proxyWin);
            logger.info(`Destroyed dedicated proxy X11 window ${widHex} on sys.Deadvertise for '${appName}'`);
          } catch (err) {
            logger.error(`Error destroying proxy window for '${appName}' on sys.Deadvertise: ${err.message}`);
          }
          ws.proxyWin = null;
        }
      } else if (msg.event === 'XAudioPlayResponseV0' || msg.intent === 'XAudioPlayResponseV0') {
        const txId = msg.txId || msg.channel;
        if (txId) {
          const routerWin = await xintent.getValidRouterWin(X, root);
          const sendResponseFn = xintent.sendXAudioPlayResponseV0 || xintent.sendXIntentEventV0;

          await sendResponseFn(X, routerWin, {
            senderWin: ws.proxyWin || clientWin,
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
          senderWin: ws.proxyWin || clientWin,
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

    if (ws.proxyWin && ws.explicitDeadvertise) {
      const widHex = xintent.widString(ws.proxyWin);
      delete serverGlobals.proxyWindowToDevice[widHex];
      if (ws.appName) delete serverGlobals.deviceProxyWindows[ws.appName];
      if (ws.xaudioSink) delete serverGlobals.deviceProxyWindows[ws.xaudioSink];

      try {
        X.DestroyWindow(ws.proxyWin);
        logger.info(`Destroyed dedicated proxy X11 window ${widHex} for '${ws.appName || 'remote-device'}' on explicit deadvertise`);
      } catch (err) {
        logger.error(`Error destroying proxy window for '${ws.appName}': ${err.message}`);
      }
      ws.proxyWin = null;
    } else if (ws.proxyWin) {
      logger.info(`Preserving proxy X11 window ${xintent.widString(ws.proxyWin)} for '${ws.appName || 'remote-device'}' during idle disconnect (available for UDP wake)`);
    }

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
  const clientIp = (request?.socket?.remoteAddress || '').replace(/^.*:/, '');
  const headersJson = JSON.stringify(request?.headers || {});
  logger.info(`[WebSocket Upgrade] Incoming upgrade request from ${clientIp || 'unknown'} for URL: ${request.url} Headers: ${headersJson}`);

  // RFC 6455 / RFC 2616 prohibits '/' in Sec-WebSocket-Protocol token names.
  // Sanitize 'message/http' -> 'message-http' so Node 'ws' parser passes tokenRegex validation.
  if (request.headers && typeof request.headers['sec-websocket-protocol'] === 'string') {
    request.headers['sec-websocket-protocol'] = request.headers['sec-websocket-protocol'].replace(/message\/http/g, 'message-http');
  }

  try {
    const hostHeader = request.headers.host || 'localhost:12345';
    const parsedUrl = new URL(request.url, `http://${hostHeader}`);
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
      logger.warn(`Rejected WebSocket upgrade for unknown path: ${pathname} from ${clientIp}`);
      if (socket.writable) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nPath not found');
      }
      socket.destroy();
    }
  } catch (err) {
    logger.error(`Error during WebSocket upgrade from ${clientIp}: ${err.message}`);
    socket.destroy();
  }
});

const HTTP_PORT = parseInt(process.env.PORT || '12345', 10);
server.listen(HTTP_PORT, '0.0.0.0', () => {
  logger.info(`matchbox202x intent server running on http://0.0.0.0:${HTTP_PORT} (WebSocket: ws://0.0.0.0:${HTTP_PORT}/ws)`);
});
})()
