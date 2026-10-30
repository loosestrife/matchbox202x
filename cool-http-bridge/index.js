const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { serializeError } = require('serialize-error');
const serverTools = require('../server-tools');
const { createClientWithPromises } = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');
const serverGlobals = require('./server-globals');
const { setupWebSocketServer } = require('./ws-server');
const routeAppModule = require('./route-app');

const EXCLUDED_XBLOB_UPLOAD_PATHS = [
  '/XBlobRead',
  '/XBlobTransfer',
  '/XBlobGrant',
  '/XBlobUnlink',
  '/XBlobSoftLink',
  '/XBlobSoftUnlink',
  '/XBlobBroadcast',
  '/broadcast',
];

function isXBlobUploadRequest(req) {
  if (req.method !== 'PUT' && req.method !== 'POST') return false;
  return !EXCLUDED_XBLOB_UPLOAD_PATHS.some((sub) => req.path.includes(sub));
}

function logXBlobUploadStart(logger, req) {
  if (!isXBlobUploadRequest(req)) return;
  const forwardedBy = req.headers['x-forwarded-by'] || '';
  const userAgent = req.headers['user-agent'] || '';
  const isFlammenwerfer =
    forwardedBy.toLowerCase().includes('flammenwerfer') ||
    userAgent.toLowerCase().includes('flammenwerfer');

  const disp = req.headers['content-disposition'] || '';
  const fileNameMatch = disp.match(/filename="?([^";]+)"?/);
  const fileName = fileNameMatch ? fileNameMatch[1] : (req.headers['x-blob-name'] || null);
  const mimeType = req.headers['content-type'] || 'application/octet-stream';
  const len = req.headers['content-length'];
  const sizeStr = len ? `${parseInt(len, 10).toLocaleString()} bytes` : 'unknown size';
  const source = isFlammenwerfer ? 'Flammenwerfer' : (forwardedBy || userAgent || req.ip || 'client');

  logger.info(`Started receiving XBlob upload from ${source}${fileName ? `: "${fileName}"` : ''} (${mimeType}, ${sizeStr})`);
}

function registerRoutes(app, logger, intentRoutes, xblobRoutes, { X, root }) {
  app.use(serverTools.loggerMiddleware);
  app.use(['/xblob', '/blobs'], (req, res, next) => {
    logXBlobUploadStart(logger, req);
    next();
  });
  app.use(['/xblob', '/blobs'], express.raw({ limit: '2gb', type: '*/*' }));
  app.use(express.json({ limit: '2gb', type: ['application/json', 'application/*+json'] }));
  app.use(express.text({ limit: '2gb', type: ['text/plain', 'text/html', 'text/xml', 'text/css'] }));
  app.use((req, res, next) => {
    if (!isXBlobUploadRequest(req) && Buffer.isBuffer(req.body) && req.body.length > 0) {
      try {
        req.body = JSON.parse(req.body.toString('utf8'));
      } catch (_) {}
    } else if (typeof req.body === 'string' && req.body.trim()) {
      try {
        req.body = JSON.parse(req.body);
      } catch (_) {
        req.body = { text: req.body };
      }
    }
    next();
  });
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Card-Window, X-Tx-Id, X-Channel-Control, X-Attached-Blob-Id, Prefer');
    next();
  });

  app.post('/intent/:namespace/:action', intentRoutes.routeIntent);
  app.post(['/xblob', '/xblob/XBlobCreate', '/blobs'], xblobRoutes.routeXBlobCreate);
  app.put(['/xblob', '/xblob/XBlobCreate', '/blobs'], xblobRoutes.routeXBlobCreate);
  app.post('/xblob/XBlobRead', xblobRoutes.routeXBlobRead);
  app.post('/xblob/XBlobTransfer', xblobRoutes.routeXBlobTransfer);
  app.post('/xblob/XBlobGrant', xblobRoutes.routeXBlobGrant);
  app.post('/xblob/XBlobUnlink', xblobRoutes.routeXBlobUnlink);
  app.delete('/xblob/XBlobUnlink', xblobRoutes.routeXBlobUnlink);
  app.delete('/xblob', xblobRoutes.routeXBlobUnlink);
  app.post('/xblob/XBlobSoftLink', xblobRoutes.routeXBlobSoftLink);
  app.post('/xblob/XBlobSoftUnlink', xblobRoutes.routeXBlobSoftUnlink);
  app.post('/xblob/XBlobBroadcast', xblobRoutes.routeXBlobBroadcast);
  app.post('/blobs/:blobId/broadcast', xblobRoutes.routeXBlobBroadcast);
  app.post('/xblob/:blobId/broadcast', xblobRoutes.routeXBlobBroadcast);
  app.put(['/xblob/:blobId', '/blobs/:blobId'], xblobRoutes.routeXBlobCreate);
  app.post(['/xblob/XBlobWrite', '/xblob/:blobId', '/blobs/:blobId'], xblobRoutes.routeXBlobCreate);
  app.get('/xblob/:blobId', xblobRoutes.routeXBlobRead);
  app.get('/blobs/:blobId', xblobRoutes.routeXBlobRead);
  app.delete('/blobs/:blobId', xblobRoutes.routeXBlobUnlink);
  app.delete('/xblob/:blobId', xblobRoutes.routeXBlobUnlink);

  app.post('/api/card-session', async (req, res) => {
    const appId = req.body?.appId || req.body?.app || 'xhtml-card';
    const cardId = req.body?.cardId || req.body?.card || 'main';
    let wid = serverGlobals.parseWindowId(req.body?.cardWin || req.headers['x-card-window']);
    if (!wid) {
      wid = await xintent.createClientWindow(X, root, `${appId}:${cardId}`);
      X.ChangeProperty(0, wid, xintent.atoms.WM_NAME, xintent.atoms.STRING, 8, Buffer.from(`${appId}:${cardId}`, 'utf8'));
      logger.info(`Allocated dedicated X11 card proxy window ${xintent.widString(wid)} for ${appId}/${cardId}`);
    }
    const record = serverGlobals.registerCardWindow(wid, appId, cardId);
    res.json({ status: 'ok', cardWin: record.widHex, wid: record.wid, appId: record.appId, cardId: record.cardId });
  });

  app.post('/api/card-hydrated', (req, res) => {
    const wid = serverGlobals.parseWindowId(req.body?.cardWin || req.headers['x-card-window']);
    if (!wid) {
      return res.status(400).json({ status: 'error', message: 'Invalid cardWin' });
    }
    const record = serverGlobals.registerCardWindow(wid, req.body?.cardApp, req.body?.cardId);
    record.hydratedReport = {
      ...(req.body || {}),
      userAgent: req.headers['user-agent'] || 'unknown',
      hydratedAt: Date.now(),
    };
    logger.info(`Browser hydrated card window ${record.widHex} (${record.appId}/${record.cardId}) via ${record.hydratedReport.userAgent}`);
    res.json({ status: 'ok', cardWin: record.widHex });
  });

  app.delete('/api/card-session/:cardWin', async (req, res) => {
    const wid = serverGlobals.parseWindowId(req.params.cardWin);
    if (!wid) {
      return res.status(400).json({ status: 'error', message: 'Invalid cardWin' });
    }
    const widHex = xintent.widString(wid);
    delete serverGlobals.cardWindows[widHex];
    try {
      X.DestroyWindow(wid);
      logger.info(`Destroyed X11 card proxy window ${widHex}`);
    } catch (_) {}
    res.json({ status: 'ok', cardWin: widHex });
  });

  const serveFavicon = (req, res) => res.sendFile(path.join(__dirname, 'assets', 'favicon.ico'));
  app.get('/favicon.ico', serveFavicon);
  app.get('/apps/favicon.ico', serveFavicon);
  app.get('/matchbox202x.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, 'assets', 'matchbox202x.js'));
  });
  app.get(['/apps/:app', '/apps/:app/*path'], routeAppModule.routeApp);
  app.get('/api/tags', async (req, res) => {
    const aggregate = await intentRoutes.aggregateTomlAsObject();
    const cardApps = routeAppModule.getApps();
    const mergedApps = { ...(aggregate.apps || {}) };
    for (const [appId, cardApp] of Object.entries(cardApps)) {
      mergedApps[appId] = {
        ...(mergedApps[appId] || {}),
        ...cardApp,
      };
    }
    res.json({
      ...aggregate,
      apps: mergedApps,
    });
  });
  app.get('/api/debug/xaudio', (req, res) => {
    res.json({
      activeStreams: intentRoutes.getActiveAudioStreams(),
      deviceProxyWindows: serverGlobals.deviceProxyWindows,
      proxyWindowToDevice: serverGlobals.proxyWindowToDevice,
      cardWindows: Object.values(serverGlobals.cardWindows).map((c) => ({
        wid: c.wid,
        widHex: c.widHex,
        appId: c.appId,
        cardId: c.cardId,
        hasWs: Boolean(c.ws && c.ws.readyState === WebSocket.OPEN),
        hydratedReport: c.hydratedReport || null,
        createdAt: c.createdAt,
      })),
      activeXChannels: Object.entries(serverGlobals.channelNatTable).map(([txId, session]) => ({
        txId: Number(txId),
        cardWin: session.cardWin ? `0x${session.cardWin.toString(16)}` : null,
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
    const store = serverTools.alStorage.getStore();
    const intentPayload = store?.values?.intentJson || req.body;
    logger[level](
      `[HTTP BRIDGE ERROR ${status}] ${err.message || err}`,
      err.stack || err,
      intentPayload ? { intentPayload } : {}
    );
    if (res.headersSent) return next(err);
    res.status(status).json(serializeError(err));
  });
}

(async () => {
  xintent.init({ logger: new serverTools.Logger({ module: 'libxintent' }) });
  const logger = new serverTools.Logger({ module: 'index.js' });
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

  const intentRoutes = require('./route-intent')({ X, root, clientWin, broadcastWsFrame });
  const xblobRoutes = require('./route-xblob')({ X, clientWin });

  const app = express();
  app.set('json spaces', 2);
  registerRoutes(app, logger, intentRoutes, xblobRoutes, { X, root });

  const server = http.createServer(app);
  setupWebSocketServer(server, { X, root, clientWin, logger, wsClients });

  const HTTP_PORT = parseInt(process.env.PORT || '12345', 10);
  server.listen(HTTP_PORT, '0.0.0.0', () => {
    logger.info(`matchbox202x intent server running on http://0.0.0.0:${HTTP_PORT} (WebSocket: ws://0.0.0.0:${HTTP_PORT}/ws)`);
  });
})();
