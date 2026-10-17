//matchbox-service-lighter/pick-files.js
const { isUtf8 } = require('node:buffer');
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const xintent = require("../x11-promises/xintent");
const { Logger } = require("../server-tools");

const logger = new Logger({ module: "xblob-host" });

const softLinks = {};
const hostBlobs = new Map();
let socketServer = null;
let currentSocketPath = null;

const pickFilePath = async xiIntent => {
  try {
    const payload = xiIntent.payload;
    const pathname = await execShell("zenity --file-selection");
    if (!pathname) throw new Error("File selection cancelled");
    const dataBlob = await xintent.XBlobCreate(X, xintent.routerWin, lighterWin, {
      xblobType: "Blob",
      type: "text/pathname",
      _dataType: "text",
      data: pathname,
    });
    xintent.XBlobTransfer(X, xintent.routerWin, lighterWin, dataBlob, xintent.routerWin);
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      targetWin: xintent.routerWin,
      senderWin: lighterWin,
      channel: xiIntent.channel,
      controlWord: 2, // FIN = 2
      payload: {
        event: "fs.PickFileResponse",
        disposition: "final",
      },
      dataBlob,
    });
  } catch (err) {
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      targetWin: xintent.routerWin,
      senderWin: lighterWin,
      channel: xiIntent.channel,
      controlWord: 2, // FIN = 2
      payload: {
        event: "http.500InternalServerError",
        disposition: "error",
        message: err.message || "File selection cancelled",
      },
    });
  }
};

const pickFile = async (xiIntent) => {
  try {
    const payload = xiIntent.payload;
    const pathname = await execShell("zenity --file-selection");
    if (!pathname) throw new Error("File selection cancelled");
    const data = fs.readFileSync(pathname);
    const isText = isUtf8(data);
    const dataBlob = await xintent.XBlobCreate(X, xintent.routerWin, lighterWin, {
      xblobType: "File",
      name: path.basename(pathname),
      type: isText ? "text/plain" : "application/octet-stream",
      _dataType: isText ? "text" : "base64",
      data: isText ? data.toString("utf-8") : data.toString("base64"),
    });
    if (payload.holdOpenForWrites) {
      xintent.XBlobSoftLink(X, xintent.routerWin, lighterWin, dataBlob);
      softLinks[dataBlob] = pathname;
    }
    xintent.XBlobTransfer(X, xintent.routerWin, lighterWin, dataBlob, xintent.routerWin);
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      targetWin: xintent.routerWin,
      senderWin: lighterWin,
      channel: xiIntent.channel,
      controlWord: 2, // FIN = 2
      payload: {
        event: "fs.PickFileResponse",
        disposition: "final",
      },
      dataBlob,
    });
  } catch (err) {
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      targetWin: xintent.routerWin,
      senderWin: lighterWin,
      channel: xiIntent.channel,
      controlWord: 2, // FIN = 2
      payload: {
        event: "http.500InternalServerError",
        disposition: "error",
        message: err.message || "File selection cancelled",
      },
    });
  }
};

const xblobBroadcast = async message => {
  const data = await xintent.XBlobRead(X, xintent.routerWin, message.blob, message.host, message.version);
  let buf;
  if(data._dataType == 'text'){
    buf = Buffer.from(data.data, 'utf-8')
  }
  if(data._dataType == 'base64'){
    buf = Buffer.from(data.data, 'base64')
  }
  fs.writeFileSync(softLinks[message.blob], buf);
}

const xblobDestructor = async message => {
  const blob = message.blob;
  delete softLinks[blob];
  hostBlobs.delete(blob);
  const numBlob = parseBlobId(blob);
  if (numBlob !== null) {
    hostBlobs.delete(numBlob);
  }
  xintent.XBlobSoftUnlink(X, xintent.routerWin, lighterWin, blob);
};

let trackChild = proc => proc;

function execShell(command) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'inherit']
    });
    trackChild(proc);

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command "${command}" failed with exit code ${code}`));
      }
    });
  });
}

const parseBlobId = (str) => {
  if (str === null || str === undefined) return null;
  if (typeof str === 'number') return str;
  if (typeof str === 'string') {
    const s = str.trim();
    if (s.startsWith('0x') || s.startsWith('0X')) {
      const parsed = parseInt(s, 16);
      return isNaN(parsed) ? null : parsed;
    }
    const parsed = parseInt(s, 10);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
};

const toHexBlobId = (id) => {
  if (id === null || id === undefined) return null;
  const num = typeof id === 'number' ? id : (typeof id === 'string' && (id.startsWith('0x') || id.startsWith('0X')) ? parseInt(id, 16) : Number(id));
  if (isNaN(num)) return id;
  return `0x${num.toString(16)}`;
};

let nextHostBlobSlot = 1;
const allocateHostBlobId = async (blobData = {}, initialHardLinker = null) => {
  try {
    let typeAtom = 0;
    if (blobData && typeof blobData === 'object') {
      const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'text/plain');
      if (mimeType) {
        typeAtom = xintent.atoms[mimeType] || (await X.InternAtom(false, mimeType));
        if (typeAtom) xintent.atoms[mimeType] = typeAtom;
      }
    }

    const cookie = crypto.randomBytes(4).readUInt32LE(0);
    const evBuf = xintent.buildClientMessageBuffer(xintent.routerWin, xintent.atoms.XBLOB_CREATE_V0, [
      lighterWin,
      cookie,
      typeAtom || 0,
      initialHardLinker || 0,
    ]);
    const responseEv = await X.seekResponsePacket(
      (ev) =>
        ev &&
        ev.type === 33 &&
        ev.message_type === xintent.atoms.XBLOB_CREATE_RESPONSE_V0 &&
        ev.data &&
        ((ev.data[2] >>> 0) === (cookie >>> 0)),
      5000
    ).SendEvent(xintent.routerWin, false, (xintent.x11 && xintent.x11.eventMask) ? xintent.x11.eventMask.NoEventMask : 0, evBuf);

    if (responseEv && responseEv.data && responseEv.data[1]) {
      return responseEv.data[1];
    }
  } catch (err) {
    logger.warn(`allocateHostBlobId XBLOB_CREATE_V0 failed, falling back to local slot: ${err.message}`);
  }

  return nextHostBlobSlot++;
};

const createXBlobSocketServer = (sockPath) => {
  if (fs.existsSync(sockPath)) {
    try {
      fs.unlinkSync(sockPath);
    } catch (_) {}
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathParts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/ping' || url.pathname === '/status')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'ok', host: os.hostname(), socketPath: sockPath }));
      }

      // Handle POST /blobs/:blobId/broadcast, POST /xblob/:blobId/broadcast, POST /xblob/XBlobBroadcast
      if (req.method === 'POST' && (url.pathname.endsWith('/broadcast') || url.pathname.includes('XBlobBroadcast'))) {
        let rawBlobId = null;
        if (url.pathname.endsWith('/broadcast')) {
          if (pathParts.length >= 2) {
            rawBlobId = pathParts[pathParts.length - 2];
          }
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            let payload = {};
            if (body) {
              try { payload = JSON.parse(body); } catch (_) {}
            }
            const targetBlob = parseBlobId(rawBlobId || payload.blobId || payload.blob || url.searchParams.get('blobId') || url.searchParams.get('blob'));
            if (!targetBlob) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ status: 'error', message: 'Invalid or missing blob ID' }));
            }
            const host = payload.host || url.searchParams.get('host') || null;
            const version = payload.version || url.searchParams.get('version') || null;

            const hexBlobId = toHexBlobId(targetBlob);
            await xintent.XBlobBroadcast(X, xintent.routerWin, lighterWin, targetBlob, host, version);
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Accept-Encoding': 'identity, base64, fd-rights',
              'X-Blob-Id': hexBlobId
            });
            res.end(JSON.stringify({ status: 'ok', blobId: hexBlobId, blob: hexBlobId }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: err.message }));
          }
        });
        return;
      }

      if (req.method === 'GET' || req.method === 'POST') {
        let rawBlobId = null;
        if (pathParts[0] === 'blobs' || pathParts[0] === 'xblob') {
          if (pathParts[1] && pathParts[1] !== 'XBlobCreate' && pathParts[1] !== 'XBlobBroadcast') {
            rawBlobId = pathParts[1];
          }
        } else if (pathParts[0]) {
          rawBlobId = pathParts[0];
        }

        const blobId = parseBlobId(rawBlobId);
        if (blobId && !url.pathname.endsWith('/broadcast')) {
          try {
            const userAgent = req.headers['user-agent'] || 'unknown';
            logger.info(`[xblob-host GET /blobs] requested blobId=${blobId} (hex: ${toHexBlobId(blobId)}) from User-Agent "${userAgent}", found in hostBlobs: ${hostBlobs.has(blobId)}, total keys: ${hostBlobs.size}`);
            let blobData = hostBlobs.get(blobId);
            if (!blobData && typeof blobId === 'number') {
              blobData = hostBlobs.get(`0x${blobId.toString(16)}`) || hostBlobs.get(String(blobId));
            }
            if (!blobData && typeof rawBlobId === 'string') {
              blobData = hostBlobs.get(rawBlobId);
            }

            if (!blobData) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ status: 'error', message: 'Blob not found' }));
            }
            const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'application/octet-stream');
            const isStream = blobData.xblobType === 'ReadableStream' || blobData.xblobType === 'MediaStream' || req.headers['x-xblob-type'] === 'ReadableStream';
            const hexBlobId = toHexBlobId(blobId);

            const wantsJson = req.headers['accept']?.includes('application/json') || url.pathname.includes('XBlobRead');
            if (wantsJson) {
              res.writeHead(200, { 'Content-Type': 'application/json', 'X-Blob-Id': hexBlobId });
              return res.end(JSON.stringify({ status: 'ok', blobId: hexBlobId, blob: blobData }));
            }

            // Handle streaming file descriptor or disk path
            let fdPath = null;
            if (typeof blobData.data === 'number' && blobData.data >= 0) {
              fdPath = `/proc/self/fd/${blobData.data}`;
            } else if (typeof blobData.data === 'string') {
              const trimmed = blobData.data.trim();
              if (trimmed.startsWith('/proc/') || trimmed.startsWith('/dev/') || fs.existsSync(trimmed)) {
                fdPath = trimmed;
              }
            }

            if (fdPath) {
              const responseHeaders = {
                'Content-Type': mimeType,
                'Accept-Encoding': 'identity, base64, fd-rights',
                'X-XBlob-Type': blobData.xblobType || 'ReadableStream',
                'X-Blob-Id': hexBlobId
              };
              if (!isStream && blobData.size) {
                responseHeaders['Content-Length'] = blobData.size;
              }
              res.writeHead(200, responseHeaders);

              if (blobData.xblobType === 'MediaStream') {
                if (!blobData.activeReadStream) {
                  blobData.activeReadStream = fs.createReadStream(fdPath);
                }
                blobData.activeReadStream.pipe(res, { end: false });
                req.on('close', () => {
                  try { blobData.activeReadStream.unpipe(res); } catch (_) {}
                });
                return;
              }

              const readStream = fs.createReadStream(fdPath);
              return readStream.pipe(res);
            }

            let bodyBuf;
            if (Buffer.isBuffer(blobData.data)) {
              bodyBuf = blobData.data;
            } else if (typeof blobData.data === 'string') {
              bodyBuf = Buffer.from(blobData.data, blobData._dataType === 'base64' ? 'base64' : 'utf8');
            } else if (blobData.data !== undefined && blobData.data !== null && typeof blobData.data === 'object') {
              if (Array.isArray(blobData.data.data)) {
                bodyBuf = Buffer.from(blobData.data.data);
              } else if (Array.isArray(blobData.data)) {
                bodyBuf = Buffer.from(blobData.data);
              } else {
                bodyBuf = Buffer.from(JSON.stringify(blobData.data), 'utf8');
              }
            } else if (blobData.data !== undefined && blobData.data !== null) {
              bodyBuf = Buffer.from(String(blobData.data), 'utf8');
            } else {
              bodyBuf = Buffer.from(JSON.stringify(blobData), 'utf8');
            }
            const responseHeaders = {
              'Content-Type': mimeType,
              'Accept-Encoding': 'identity, base64, fd-rights',
              'X-XBlob-Type': blobData.xblobType || 'Blob',
              'X-Blob-Id': hexBlobId
            };
            if (!isStream) {
              responseHeaders['Content-Length'] = bodyBuf.length;
            }
            const contentEnc = blobData.contentEncoding || (blobData._dataType === 'fd-rights' ? 'fd-rights' : (blobData._dataType === 'base64' ? 'base64' : null));
            if (contentEnc && contentEnc !== 'identity') {
              responseHeaders['Content-Encoding'] = contentEnc;
            }
            res.writeHead(200, responseHeaders);
            return res.end(bodyBuf);
          } catch (err) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'error', message: err.message }));
          }
        }
      }

      // Handle creation or modification routes: PUT/POST /blobs, /xblob, /xblob/XBlobCreate, /blobs/:blobId, /xblob/:blobId
      const isCreateOrUpdateRoute = (req.method === 'PUT' || req.method === 'POST') && (
        url.pathname === '/blobs' ||
        url.pathname === '/xblob' ||
        url.pathname === '/xblob/XBlobCreate' ||
        ((pathParts[0] === 'blobs' || pathParts[0] === 'xblob') && pathParts[1] && pathParts[1] !== 'broadcast')
      );

      if (isCreateOrUpdateRoute) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            let blobData = {};
            if (body) {
              try {
                blobData = JSON.parse(body);
              } catch (_) {
                if (body.includes('\r\n\r\n') || body.includes('Content-Type:')) {
                  blobData = xintent.parseXBlobAtRest(body);
                } else {
                  blobData = { data: body };
                }
              }
            }

            const transferEnc = req.headers['content-encoding'] || req.headers['content-transfer-encoding'];
            const isFdRights = (transferEnc && transferEnc.toLowerCase().includes('fd-rights')) || req.headers['content-type']?.includes('fd-rights');

            if (isFdRights) {
              blobData._dataType = 'fd-rights';
              blobData.contentEncoding = 'fd-rights';
              if (!blobData.data && body) {
                blobData.data = body.trim();
              }
            } else if (transferEnc && transferEnc.toLowerCase().includes('base64')) {
              blobData._dataType = 'base64';
              blobData.contentEncoding = 'base64';
            }

            if (!blobData.type && req.headers['content-type']) {
              blobData.type = req.headers['content-type'];
            }
            if (!blobData.xblobType && req.headers['x-xblob-type']) {
              blobData.xblobType = req.headers['x-xblob-type'];
            }

            let rawBlobId = null;
            if (pathParts.length >= 2 && pathParts[1] !== 'XBlobCreate' && pathParts[1] !== 'broadcast') {
              rawBlobId = pathParts[1];
            }
            const targetBlob = parseBlobId(rawBlobId);

            let requestSenderWin = null;
            const originHeader = req.headers['origin'] || req.headers['x-origin'] || req.headers['x-sender-win'];
            if (originHeader) {
              const originParts = String(originHeader).split('/');
              const lastPart = originParts[originParts.length - 1];
              if (lastPart) {
                if (lastPart.startsWith('0x') || lastPart.startsWith('0X')) {
                  requestSenderWin = parseInt(lastPart, 16);
                } else if (!isNaN(Number(lastPart))) {
                  requestSenderWin = Number(lastPart);
                }
              }
            }

            let blobId;
            if (targetBlob) {
              blobId = targetBlob;
            } else {
              if (!requestSenderWin) {
                requestSenderWin = lighterWin || 0x1000;
              }
              blobId = await allocateHostBlobId(blobData, requestSenderWin);
            }

            // Per polyfills.md: If given a ReadableStream pipe/fd, XBlobHost turns it into a storage-backed file
            const isReadableStream = blobData.xblobType === 'ReadableStream' || req.headers['x-xblob-type'] === 'ReadableStream';
            if (isReadableStream && blobData.data) {
              const srcPath = typeof blobData.data === 'number' ? `/proc/self/fd/${blobData.data}` : String(blobData.data).trim();
              if (srcPath && (srcPath.startsWith('/proc/') || srcPath.startsWith('/dev/') || fs.existsSync(srcPath))) {
                try {
                  const storagePath = path.join(os.tmpdir(), `xblob_stream_${blobId}_${Date.now()}.tmp`);
                  const writeStream = fs.createWriteStream(storagePath);
                  const readStream = fs.createReadStream(srcPath);

                  blobData.storagePath = storagePath;
                  blobData.data = storagePath;

                  logger.info(`[xblob-host] Created storage-backed anonymous file descriptor/file for piped ReadableStream XBlob ${toHexBlobId(blobId)} at '${storagePath}' from source '${srcPath}'`);

                  readStream.pipe(writeStream);
                  readStream.on('end', async () => {
                    try {
                      const stats = fs.statSync(storagePath);
                      blobData.size = stats.size;
                      blobData.xblobType = 'Blob'; // Promote ReadableStream to Blob upon completion
                      logger.info(`Promoted ReadableStream XBlob ${toHexBlobId(blobId)} to Blob (final size: ${blobData.size} bytes)`);
                    } catch (_) {}
                  });
                  readStream.on('error', (err) => {
                    logger.warn(`ReadableStream pipe error for XBlob ${toHexBlobId(blobId)}: ${err.message}`);
                  });
                } catch (err) {
                  logger.warn(`Failed turning ReadableStream into storage-backed file for XBlob ${toHexBlobId(blobId)}: ${err.message}`);
                }
              }
            }

            hostBlobs.set(blobId, blobData);
            if (typeof blobId === 'number') {
              hostBlobs.set(`0x${blobId.toString(16)}`, blobData);
              hostBlobs.set(String(blobId), blobData);
            }
            const hexBlobId = toHexBlobId(blobId);
            const statusCode = (req.method === 'PUT' && !targetBlob) ? 201 : 200;
            const resHeaders = {
              'Content-Type': 'application/json',
              'Accept-Encoding': 'identity, base64, fd-rights',
              'X-Blob-Id': hexBlobId,
              'Location': `/blobs/${hexBlobId}`
            };
            if (isFdRights || blobData.contentEncoding === 'fd-rights') {
              resHeaders['Content-Encoding'] = 'fd-rights';
            }

            res.writeHead(statusCode, resHeaders);
            res.end(JSON.stringify({ status: 'ok', blobId: hexBlobId, blob: hexBlobId, contentEncoding: blobData.contentEncoding || 'identity' }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', message: err.message }));
          }
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Not found' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
  });

  server.listen(sockPath, () => {
    logger.info(`XBlob socket listening at ${sockPath}`);
  });

  server.on('error', (err) => {
    logger.error(`XBlob socket server error:`, err);
  });

  const cleanup = () => {
    if (fs.existsSync(sockPath)) {
      try {
        fs.unlinkSync(sockPath);
      } catch (_) {}
    }
  };

  process.on('exit', cleanup);

  return { server, cleanup };
};

let X;
let lighterWin;
let blobHostWin;

const init = async g => {
  X = g.X;
  lighterWin = g.lighterWin;
  blobHostWin = g.blobHostWin || lighterWin;
  if (g.trackChild) {
    trackChild = g.trackChild;
  }
  const hostname = os.hostname();
  const hostAtom = await X.InternAtom(false, `XBLOB_HOST_${hostname}`);
  X.SetSelectionOwner(blobHostWin, hostAtom, 0);

  currentSocketPath = process.env.XBLOB_SOCKET_PATH || path.join(os.tmpdir(), `xblob-${hostname}-${process.pid}.sock`);
  const { server } = createXBlobSocketServer(currentSocketPath);
  socketServer = server;

  const xblobSocketPathAtom = await X.InternAtom(false, 'XBLOB_SOCKET_PATH');
  X.ChangeProperty(0, blobHostWin, xblobSocketPathAtom, X.atoms.STRING, 8, currentSocketPath);
  logger.info(`Advertised XBLOB_SOCKET_PATH property on blobHostWin (0x${blobHostWin.toString(16)}): ${currentSocketPath}`);
};

module.exports = {
  init,
  pickFilePath,
  pickFile,
  xblobDestructor,
  xblobBroadcast,
  getSocketPath: () => currentSocketPath,
};
