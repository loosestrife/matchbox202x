const path = require('node:path');
const { Readable } = require('node:stream');
const { spawn } = require('child_process');
const {Logger, HttpError} = require('./server-tools');
const {nnjsonStream} = require('./nnjson-stream');
const {packageRegistry, intentRegistry} = require('./package-registry');

const logger = Logger({module: 'route-intent'});

module.exports.routeIntent = (req, res) => {
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

  const nnjsonStdout = Readable.from(nnjsonStream(teeOutStream(child.stdout)));
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
}

module.exports.routeIntent = (req, res) => {
  const { namespace, action } = req.params;
  const intent = `${namespace}.${action}`;
  const targetApp = req.query.app || req.body.app;
  if (req.query.app && req.query.app != req.body.app)
    throw new HttpError(400, 'advisory query string app specification must match app specified in intent json');
  if (intent != req.body.intent)
    throw new HttpError(400, 'url path intent must match intent specified in intent json');
  const payload = req.body;
  logger.info(`[INTENT] ${intent} -> Target: ${targetApp}`);
  res.setHeader('Matchbox-Bridge', '1.0');

  const registeredApps = intentRegistry[intent];
  if (registeredApps === undefined || registeredApps.length == 0)
    throw new HttpError(400, `no apps registered for ${intent}`);
  if (targetApp && !(registeredApps.includes(targetApp)))
    throw new HttpError(400, `${targetApp} not registered for ${intent}`);
  const pakName = targetApp || registeredApps[0];
  const pak = packageRegistry[pakName];
  const selectedApp = pak.package.id;
  const pakIntent = pak.intents[intent];
  if (!(['pipe', 'command'].includes(pakIntent.invocation)))
    throw new HttpError(500, `invocation ${pakIntent.invocation} not implemented`);

  res.setHeader('Content-Type', 'multipart/mixed; boundary=intent_boundary');
  res.write(httpFrame(JSON.stringify({ intent: `sys.Processing`, status: "dispatched" })));
  logger.debug("selected intent", pakIntent);

  let args = [...(pakIntent.args || [])];
  if (pakIntent.invocation == 'command') {
    args.push('--intent', intent);
    args.push('--data', JSON.stringify(payload));
    if (targetApp)
      args.push('--app', targetApp);
  }
  const child = spawn(pakIntent.exec, {
    cwd: path.resolve(pak._path, pakIntent.execDir),
    env: {...process.env, ...pakIntent.env},
    shell: true,
    stdio: ['pipe', 'pipe', 'inherit']
  });
  if (pakIntent.invocation == 'pipe') {
    if (typeof connectedServers !== 'undefined') {
      connectedServers[selectedApp] = child;
    }
    child.stdin.write(JSON.stringify(payload) + '\n\n');
  }

  const nnjsonStdout = Readable.from(nnjsonStream(child.stdout));
  nnjsonStdout.on('data', frame => {
    res.write(httpFrame(JSON.stringify(frame, null, 2)));

    // Slurp and emit { attachment: { path, mimeType, unlink } }
    if (frame.attachment && frame.attachment.path) {
      const { path: filePath, mimeType, unlink: shouldUnlink } = frame.attachment;
      const fileName = path.basename(filePath);

      try {
        // Open descriptor first
        const fd = fs.openSync(filePath, 'r');

        // Immediate unlink if requested (deletes file name entry, leaves open inode active)
        if (shouldUnlink) {
          try {
            fs.unlinkSync(filePath);
            logger.debug(`[ATTACHMENT] Unlinked ${filePath} immediately after opening fd ${fd}`);
          } catch (unlinkErr) {
            logger.error(`[ATTACHMENT] Failed to unlink ${filePath}:`, unlinkErr);
          }
        }

        const stat = fs.fstatSync(fd);
        res.write(httpFrame(null, {
          'Content-Type': mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Content-Length': stat.size,
        }, headersOnly=true));
        const fileBuf = Buffer.alloc(stat.size);
        fs.readSync(fd, fileBuf, 0, stat.size, 0);
        fs.closeSync(fd);
        res.write(fileBuf);
      } catch (err) {
        logger.error(`[ATTACHMENT] Failed to read attachment at ${filePath}:`, err);
        res.write(httpFrame(JSON.stringify({intent: 'sys.FileNotFound', msg: `${pakName} process <-> NIHRPCXD file transfer failed`, disposition: 'error'})));
        res.end()
        throw err;
      }
    }

    if (frame.disposition === 'final') {
      res.end();
    }
  });

  child.on('close', (code) => {
    logger.info(`intent server ${selectedApp} for ${intent} ended`);
    if (typeof connectedServers !== 'undefined') {
      connectedServers[selectedApp] = null;
    }
    if(!res.writableEnded){
      res.write(httpFrame(JSON.stringify({intent: 'sys.ECONNRESET', msg: `${pakName} process ended without sending final message`, disposition: 'error'})));
      res.end();
    }
  });
};

const BOUNDARY = 'intent_boundary';
function httpFrame(body, headers = {}, headersOnly=false) {
  // Normalize header keys and default to JSON if missing Content-Type
  const headersObj = {
    'Content-Type': 'application/json',
    ...headers,
  };

  const headerLines = Object.entries(headersObj).map(
    ([key, val]) => `${key}: ${val}`
  );

  const parts = [
    `--${BOUNDARY}`,
    ...headerLines,
    '',
  ]
  if(!headersOnly){
    parts.push(body, '');
  }

  return parts.join('\r\n');
}