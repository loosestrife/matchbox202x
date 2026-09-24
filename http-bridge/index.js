const express = require('express');
const {serializeError} = require('serialize-error')
const {HttpError, Logger, loggerMiddleware, nnjsonStream, teeOutStream} = require('../server-tools');
const { createClientWithPromises } = require('../x11-promises/x11-promises');
const { connectToRouter, createClientWindow } = require('../x11-promises/xintent');

const logger = new Logger({module: 'index.js'});
const { X, root } = await createClientWithPromises();
const routerWin = await connectToRouter(X, root);
const clientWin = await createClientWindow(X, root, 'http-intent-bridge');
const { routeIntent } = require('./route-intent')({ routerWin, X, root, clientWin });

const app = express();
app.use(express.json());
app.use(loggerMiddleware);
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.post('/intent/:namespace/:action', routeIntent);
app.get('/matchbox202x.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'http-everything', 'assets', 'matchbox202x.js'));
});
app.get('/intents', (req, res) => {
  res.json({todo: 'aggregate available intents onto a property of routerWin'});
});
//app.get('/apps/:app{/:card}', routeApp);

app.use((err, req, res, next) => {
  const status = err.httpCode || 500;
  const level = status < 500 ? 'info' : 'error';
  logger[level]('Express error handler:', err);
  res.status(status);
  res.json(serializeError(err));
});

// this is for localhost only, use tailscale to bridge it
app.listen(12345, 'localhost', () => {
  logger.info('matchbox202x intent server running on http://localhost:12345');
});