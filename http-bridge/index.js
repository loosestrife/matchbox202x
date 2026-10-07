const path = require('path');
const express = require('express');
const {serializeError} = require('serialize-error');
const {HttpError, Logger, loggerMiddleware, alStorage, nnjsonStream, teeOutStream} = require('../server-tools');
const { createClientWithPromises } = require('../x11-promises/x11-promises');
const { connectToRouter, createClientWindow } = require('../x11-promises/xintent');

(async () => {
const logger = new Logger({module: 'index.js'});
logger.setProjectName('http-bridge');
const { X, root } = await createClientWithPromises();
const routerWin = await connectToRouter(X, root);
const clientWin = await createClientWindow(X, root, 'http-intent-bridge');
const { routeIntent, aggregateTomlAsObject } = require('./route-intent')({ routerWin, X, root, clientWin });
const { routeApp, getApps } = require('./route-app');

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
app.get('/matchbox202x.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'assets', 'matchbox202x.js'));
});
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'assets', 'favicon.ico'));
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

  if (intentPayload) {
    logger[level]('Express error handler:', err, 'Intent JSON:', intentPayload);
  } else {
    logger[level]('Express error handler:', err);
  }

  res.status(status);
  res.json(serializeError(err));
});

// localhost bridge
app.listen(12345, 'localhost', () => {
  logger.info('matchbox202x intent server running on http://localhost:12345');
});
})()
