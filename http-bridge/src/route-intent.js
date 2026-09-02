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

  const nnjsonStdout = Readable.from(nnjsonStream(child.stdout, teeOut=true));
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
  const pak = packageRegistry[targetApp || registeredApps[0]];
  const selectedApp = pak.package.id;
  const pakIntent = pak.intents[intent];
  if (!(['pipe', 'command'].includes(pakIntent.invocation)))
    throw new HttpError(500, `invocation ${pakIntent.invocation} not implemented`);

  res.setHeader('Content-Type', 'multipart/mixed; boundary=intent_boundary');
  const boundaryMarker = '--intent_boundary';
  const contentTypeJson = 'Content-Type: application/json';
  res.write(`${boundaryMarker}\r\n${contentTypeJson}\r\n\r\n`);
  res.write(JSON.stringify({ intent: `sys.Processing`, status: "dispatched" }) + '\r\n\r\n');

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
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (pakIntent.invocation == 'pipe') {
    if (typeof connectedServers !== 'undefined') {
      connectedServers[selectedApp] = child;
    }
    child.stdin.write(JSON.stringify(payload) + '\n\n');
  }

  const nnjsonStdout = Readable.from(nnjsonStream(child.stdout));
  nnjsonStdout.on('data', frame => {
    // 1. Emit JSON frame block
    const jsonBlock = [
      contentTypeJson,
      '',
      JSON.stringify(frame, null, 2),
      ''
    ].join('\r\n');
    res.write(`${jsonBlock}\r\n${boundaryMarker}\r\n`);

    // 2. Slurp and emit { attachment: { path, mimeType, unlink } }
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
        const attachmentHeaders = [
          `Content-Type: ${mimeType || 'application/octet-stream'}`,
          `Content-Disposition: attachment; filename="${fileName}"`,
          `Content-Length: ${stat.size}`,
          '',
          ''
        ].join('\r\n');

        res.write(attachmentHeaders);

        // Slurp binary contents using open descriptor
        const fileBuf = Buffer.alloc(stat.size);
        fs.readSync(fd, fileBuf, 0, stat.size, 0);
        fs.closeSync(fd);

        res.write(fileBuf);
        res.write(`\r\n${boundaryMarker}\r\n`);
      } catch (err) {
        logger.error(`[ATTACHMENT] Failed to read attachment at ${filePath}:`, err);
      }
    }

    if (frame.disposition === 'final') {
      res.end();
    }
  });

  child.on('close', (code) => {
    if (typeof connectedServers !== 'undefined') {
      connectedServers[selectedApp] = null;
    }
  });
};