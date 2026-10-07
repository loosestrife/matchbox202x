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
app.use(express.json());
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

// localhost bridge
app.listen(12345, 'localhost', () => {
  logger.info('matchbox202x intent server running on http://localhost:12345');
});
})()
