const conf = require('./conf');

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const {serializeError} = require('serialize-error')
const HttpError = require('./http-errors');
const Logger = require('./logger');
const NnjsonStream = require('./nnjson-stream');

const logger = Logger({module: 'index.js'});
const {packageRegistry, intentRegistry} = require('./package-registry');
const connectedServers = {};

const app = express();
app.use(express.json());

// Enable CORS for external HTML cards fetching from localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// -----------------------------------------------------------------------------
// 1. Deliver matchbox202x.js from the same directory
// -----------------------------------------------------------------------------
app.get('/matchbox202x.js', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'assets', 'matchbox202x.js'));
});

// if we ever serve intents to non trusted clients, these will have to be filtered
app.get('/intents', (req, res) => {
  res.json({intentRegistry, packageRegistry});
});
// -----------------------------------------------------------------------------
// 2. Intent Gateway: POST /intent/:namespace/:action
// -----------------------------------------------------------------------------
app.post('/intent/:namespace/:action', (req, res) => {
  const { namespace, action } = req.params;
  const intent = `${namespace}.${action}`;
  const targetApp = req.query.app || req.body.app;
  if(req.query.app && req.query.app != req.body.app)
    throw new HttpError(400, 'advisory query string app specification must match app specified in intent json');
  if(intent != req.body.intent)
    throw new HttpError(400, 'url path intent must match intent specified in intent json');
  const payload = req.body;
  logger.info(`[INTENT] ${intent} -> Target: ${targetApp}`);
  res.setHeader('Matchbox-Bridge', '1.0');

  const registeredApps = intentRegistry[intent];
  if(registeredApps === undefined || registeredApps.length == 0)
    throw new HttpError(400, `no apps registered for ${intent}`);
  if(targetApp && !(registeredApps.includes(targetApp)))
    throw new HttpError(400, `${targetApp} not registered for ${intent}`);
  const pak = packageRegistry[targetApp || registeredApps[0]];
  const selectedApp = pak.package.id;
  const pakIntent = pak.intents[intent];
  if(!(['pipe', 'command'].includes(pakIntent.invocation)))
    throw new HttpError(500, `invocation ${pakIntent.invocation} not implemented`);

  res.setHeader('Content-Type', 'multipart/mixed; boundary=intent_boundary');
  const boundaryMarker = '--intent_boundary';
  const contentTypeJson = 'Content-Type: application/json';
  res.write(`${boundaryMarker}\r\n${contentTypeJson}\r\n\r\n`);
  res.write(JSON.stringify({ intent: `sys.Processing`, status: "dispatched" }) + '\r\n');

  logger.debug("selected intent", pakIntent);
  let args = [...(pakIntent.args || [])];
  if(pakIntent.invocation == 'command'){
    args.push('--intent', intentName);
    args.push('--data', JSON.stringify(payload));
    if(targetApp)
      args.push('--app', targetApp);
  }
  // TODO: env, execDir
  const child = spawn(pakIntent.exec, args);
  if(pakIntent.invocation == 'pipe')
    connectedServers[selectedApp] = child;

  const nnjsonStdout = Readable.from(nnjsonStream(child.stdout));
  nnjsonStdout.on('data', frame => {
    const out = [contentTypeJson, JSON.stringify(frame, null, 2), boundaryMarker];
    res.write(out.join('\r\n') + '\r\n\r\n');
    if(frame.attachment){
      const fd = frame.attachment.fd;
      delete frame.attachment.fd;
      const procFdPath = `/proc/${child.pid}/fd/${finalMsg.fd}`;
      const abuf = fs.readFileSync(procFdPath);
      sendChildMessage({event: 'ReadComplete', fd});
      const out = [
        `Content-Type: ` + frame.attachmentMimeType,
        `Content-Disposition: attachment; filename="${frame.attachmentName}"`,
        `Content-Length: ${abuf.size}`,
      ];
      res.write(out.join('\r\n'));
      res.write(abuf);
      res.write(boundaryMarker + '\r\n\r\n');
    }
    if(frame.disposition == 'final'){
      res.end();
    }
  });
  child.on('close', (code) => {
    connectedServers[selectedApp] = null;
  });
});

// 3. app server
app.get('/apps/:app{/:card}', (req, res) => {
  const package = packageRegistry[req.params.app];
  const appName = req.params.app;
  if(!package) throw new HttpError(400, `package ${appName} not found`);
  const app = package.app;
  if(!app) throw new HttpError(400, `package ${appName} is not an app`);
  let cardId;
  if(req.params.card){
    cardId = req.params.card;
  } else {
    if(app.main?.type != "html") throw new HttpError(400, `cant serve main type ${app.main?.type} of ${appName}`);
    cardId = app.main.card;
  }
  const card = package.cards.filter(c => c.id == cardId)[0];
  let cardPath = card.path;
  if(!(card.path.startsWith('/'))){
    cardPath = path.join(package._path, cardPath);
  }
  logger.info(`sending ${cardPath}`)
  res.sendFile(cardPath);
});

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