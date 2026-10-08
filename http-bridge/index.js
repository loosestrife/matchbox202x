const path = require('path');
const express = require('express');
const {serializeError} = require('serialize-error');
const {HttpError, Logger, loggerMiddleware, alStorage, nnjsonStream, teeOutStream} = require('../server-tools');
const { createClientWithPromises } = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');


(async () => {
xintent.init({logger: new Logger({module: 'libxintent'})});
const logger = new Logger({module: 'index.js'});
logger.setProjectName('http-bridge');
const { X, root } = await createClientWithPromises();
await xintent.connectToRouter(X, root);
const clientWin = await xintent.createClientWindow(X, root, 'http-intent-bridge');
const { routeIntent, aggregateTomlAsObject } = require('./route-intent')({ X, root, clientWin });
const { routeApp, getApps } = require('./route-app');
const {
  routeXBlobCreate,
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
  res.sendFile(path.join(__dirname, 'assets', 'matchbox202x.js'));
});
app.get('/apps/:app{/:card}', routeApp);
app.get('/api/tags', async (req, res) => {
  res.json({
    ...await aggregateTomlAsObject(),
    apps: getApps(),
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

const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });
const wsClients = new Set();

wss.on('connection', (ws) => {
  logger.info('[http-bridge] Remote WebSocket client connected (e.g. Flammenwerfer)');
  wsClients.add(ws);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString('utf8'));
      logger.info('[http-bridge] Remote WebSocket message received:', msg);

      if (msg.event === 'sys.Advertise' || msg.intent === 'sys.Advertise') {
        const appName = msg.app || 'flammenwerfer-phone';
        logger.info(`[http-bridge] Processing sys.Advertise for app '${appName}'`);
        if (msg.manifest) {
          await X.ChangeProperty(
            0,
            clientWin,
            xintent.atoms.MATCHBOX_TOML,
            xintent.atoms.STRING,
            8,
            Buffer.from(msg.manifest, 'utf8')
          );
          await xintent.getAllMatchboxToml();
          logger.info(`[http-bridge] Registered MATCHBOX_TOML manifest for '${appName}' on router`);
        }
      } else if (msg.intent) {
        const routerWin = await xintent.getValidRouterWin(X, root);
        await xintent.sendXIntentIntentV0(X, routerWin, {
          senderWin: clientWin,
          payload: msg,
        });
      }
    } catch (err) {
      logger.error('[http-bridge] Remote WebSocket message error:', err.message);
    }
  });

  ws.on('close', () => {
    logger.info('[http-bridge] Remote WebSocket client disconnected');
    wsClients.delete(ws);
  });
});

server.on('upgrade', (request, socket, head) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    if (pathname === '/ws' || pathname === '/remote-intents') {
      wss.handleUpgrade(request, socket, head, (ws) => {
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
