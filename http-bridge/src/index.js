const conf = require('./conf');

const express = require('express');
const path = require('path');
const {serializeError} = require('serialize-error')
const {HttpError, Logger} = require('./server-tools');
const nnjsonStream = require('./nnjson-stream');
const {packageRegistry, intentRegistry} = require('./package-registry');

const logger = Logger({module: 'index.js'});
const {routeIntent} = require('./route-intent');
const {routeApp} = require('./route-app');
const connectedServers = {};

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/matchbox202x.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', 'matchbox202x.js'));
});
app.get('/intents', (req, res) => {
  // if we ever serve intents to non trusted clients, these will have to be filtered111
  res.json({intentRegistry, packageRegistry});
});
app.post('/intent/:namespace/:action', routeIntent);
app.get('/apps/:app{/:card}', routeApp);

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