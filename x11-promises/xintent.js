const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const x11 = require("./x11-promises");
let Logger, alStorage;
try {
  const serverTools = require("../server-tools");
  Logger = serverTools.Logger;
  alStorage = serverTools.alStorage;
} catch (_) {}

const createConsoleLogger = (moduleName = "xintent") => ({
  info: (...args) => console.log(`[${moduleName} info]`, ...args),
  warn: (...args) => console.warn(`[${moduleName} warn]`, ...args),
  error: (...args) => console.error(`[${moduleName} error]`, ...args),
  debug: (...args) => (console.debug ? console.debug(`[${moduleName} debug]`, ...args) : console.log(`[${moduleName} debug]`, ...args)),
  log: (...args) => console.log(`[${moduleName}]`, ...args),
  setContext: () => {}
});

let logger = Logger ? new Logger({ module: "xintent" }) : createConsoleLogger("xintent");

function init(options = {}) {
  if (options.logger) {
    logger = options.logger;
  }
  return { logger };
}

const atoms = {};
const widString = (wid) => "0x" + wid.toString(16);

async function getRouterWin(X, root) {
  try {
    let candidateRouterWin = atoms.XCHANNEL ? await X.GetSelectionOwner(atoms.XCHANNEL) : 0;
    if (!candidateRouterWin && atoms.XINTENT) {
      candidateRouterWin = await X.GetSelectionOwner(atoms.XINTENT);
    }
    if (!candidateRouterWin) {
      module.exports.routerWin = undefined;
      return null;
    }
    await X.GetWindowAttributes(candidateRouterWin);
    const nameProp = await X.GetProperty(
      0,
      candidateRouterWin,
      atoms.WM_NAME,
      atoms.STRING,
      0,
      20
    );
    const wName = nameProp && nameProp.data ? nameProp.data.toString("utf8").trim() : "";
    if (wName !== "XCHANNEL_BUSMASTER" && wName !== "XINTENT_ROUTER") {
      module.exports.routerWin = undefined;
      return null;
    }
    module.exports.routerWin = candidateRouterWin;
    return candidateRouterWin;
  } catch (err) {
    module.exports.routerWin = undefined;
    return null;
  }
}

async function connectToRouter(X, root, timeoutMs = 0) {
  const requiredAtoms = ["XCHANNEL", "XINTENT", "XINTENT_INTENT_V0"];
  const requiredResults = await Promise.all(
    requiredAtoms.map(async (atomName) => {
      const atom = await X.InternAtom(false, atomName);
      if (!atom) {
        logger.warn(`required atom ${atomName} not on server`);
      }
      atoms[atomName] = atom;
      return atom;
    })
  );
  if (requiredResults.some((atom) => !atom)) {
    return 0;
  }

  const protocolAtoms = [
    "STRING",
    "WINDOW",
    "WM_NAME",
    "WM_CLASS",
    "_NET_WM_PID",
    "CARDINAL",

    'MATCHBOX_TOML',
    'AGGREGATE_TOML',
    'SERVICE_MANIFEST_TOML',

    "XINTENT_EVENT_V0",
    "XBLOB_CREATE_V0",
    "XBLOB_CREATE_RESPONSE_V0",
    "XBLOB_GRANT_V0",
    "XBLOB_UNLINK_V0",
    "XBLOB_TRANSFER_V0",
    "XBLOB_BROADCAST_V0",
    "XBLOB_SOFT_LINK_V0",
    "XBLOB_SOFT_UNLINK_V0",
    "XBLOB_ANNOUNCE_HOST_V0",
    "XBLOB_DROP_HOST_V0",
    "XBLOB_DESTRUCTOR_V0",
    "XBLOB_SOCKET_PATH",

    "XAUDIO_PLAY_V0",
    "XAUDIO_PLAY_RESPONSE_V0",
    "XAUDIO_CONTROL_V0",
    "XAUDIO_PREFETCH_SOUND_BLOB_V0",
    "XAUDIO_SEEK_STREAM_V0",
    "XAUDIO_GET_AUDIO_OUTPUTS_V0",

    "SESSION_SPEAKERS",

    "message/http",
  ];

  await Promise.all(
    protocolAtoms.map(async (atomName) => {
      atoms[atomName] = await X.InternAtom(false, atomName);
    })
  );

  if (!module.exports._hasXIntentListener) {
    module.exports._hasXIntentListener = true;
    try {
      X.ChangeWindowAttributes(root, { eventMask: x11.eventMask.PropertyChange });
    } catch (_) {}
    X.on('event', async ev => {
      if (ev.name === 'DestroyNotify' && ev.wid == module.exports.routerWin) {
        module.exports.routerWin = undefined;
      }
      if (ev.name === 'PropertyNotify' && ev.wid === root && (ev.atom === atoms.XINTENT || ev.atom === atoms.XCHANNEL)) {
        await getRouterWin(X, root);
      }
    });
  }

  return await waitForRouterWin(X, root, timeoutMs);
}

async function waitForRouterWin(X, root, timeoutMs = 0) {
  if (module.exports.routerWin) {
    try {
      await X.GetWindowAttributes(module.exports.routerWin);
      return module.exports.routerWin;
    } catch (_) {
      module.exports.routerWin = undefined;
    }
  }

  const immediate = await getRouterWin(X, root);
  if (immediate) return immediate;
  if (timeoutMs <= 0) return null;

  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;

    const propertyHandler = async (ev) => {
      if (ev && ev.name === 'PropertyNotify' && ev.wid === root && (ev.atom === atoms.XINTENT || ev.atom === atoms.XCHANNEL)) {
        const candidate = await getRouterWin(X, root);
        if (candidate && !resolved) {
          resolved = true;
          if (timer) clearTimeout(timer);
          X.removeListener('event', propertyHandler);
          resolve(candidate);
        }
      }
    };

    X.on('event', propertyHandler);

    const pollInterval = setInterval(async () => {
      if (resolved) {
        clearInterval(pollInterval);
        return;
      }
      const candidate = await getRouterWin(X, root);
      if (candidate && !resolved) {
        resolved = true;
        clearInterval(pollInterval);
        if (timer) clearTimeout(timer);
        X.removeListener('event', propertyHandler);
        resolve(candidate);
      }
    }, 250);

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(pollInterval);
          X.removeListener('event', propertyHandler);
          resolve(module.exports.routerWin || null);
        }
      }, timeoutMs);
    }
  });
}

async function getValidRouterWin(X, root) {
  return await waitForRouterWin(X, root, 5000);
}

/**
 * Creates a minimal 1x1 X11 IPC window pre-configured with _NET_WM_PID
 * and WM_CLASS so XSECURE V0 can inspect client credentials.
 */
async function createClientWindow(X, root, name = "xintent-client") {
  const clientWin = X.AllocID();

  // Create 1x1 unmapped window (0 round-trips)
  X.CreateWindow(clientWin, root, 0, 0, 1, 1, 0, 0, 0, 0, {
    eventMask: x11.eventMask.PropertyChange,
  });

  const pidBuf = Buffer.alloc(4);
  pidBuf.writeUInt32LE(process.pid, 0);
  X.ChangeProperty(0, clientWin, atoms._NET_WM_PID, atoms.CARDINAL, 32, pidBuf);

  const wmClass = Buffer.from(`${name}\0${name}\0`);
  X.ChangeProperty(0, clientWin, atoms.WM_CLASS, atoms.STRING, 8, wmClass);

  return clientWin;
}

function buildClientMessageBuffer(targetWin, message_type, data) {
  const ev = Buffer.alloc(32);
  ev.writeInt8(33, 0); // ClientMessage
  ev.writeInt8(32, 1); // 32-bit format
  ev.writeUInt32LE((targetWin || 0) >>> 0, 4);
  ev.writeUInt32LE((message_type || 0) >>> 0, 8);
  for (let i = 0; i < data.length && i < 5; i++) {
    ev.writeUInt32LE((data[i] || 0) >>> 0, 12 + 4 * i);
  }
  return ev;
}

async function XClientMessage(X, targetWin, message_type, data) {
  const ev = buildClientMessageBuffer(targetWin, message_type, data);
  return X.SendEvent(targetWin, false, x11.eventMask.NoEventMask, ev);
}

const toHexBlobId = (id) => {
  if (id === null || id === undefined) return null;
  const num = typeof id === 'number' ? id : (typeof id === 'string' && (id.startsWith('0x') || id.startsWith('0X')) ? parseInt(id, 16) : Number(id));
  if (isNaN(num)) return id;
  return `0x${num.toString(16)}`;
};

async function httpPutBlobsOverSocket(sockPath, blobData, senderWin, targetBlobId = null) {
  if (!senderWin) {
    throw new Error('httpPutBlobsOverSocket requires senderWin');
  }
  return new Promise((resolve, reject) => {
    let bodyBuf;
    if (Buffer.isBuffer(blobData)) {
      bodyBuf = blobData;
    } else if (typeof blobData === 'string') {
      bodyBuf = Buffer.from(blobData, 'utf8');
    } else if (typeof blobData === 'object' && blobData !== null) {
      if (blobData._dataType === 'binary' && Buffer.isBuffer(blobData.data)) {
        bodyBuf = blobData.data;
      } else {
        bodyBuf = Buffer.from(formatXBlobAtRest(blobData), 'utf8');
      }
    } else {
      bodyBuf = Buffer.from(String(blobData), 'utf8');
    }

    const contentEncoding = (typeof blobData === 'object' && blobData !== null) ? (blobData.contentEncoding || (blobData._dataType === 'fd-rights' ? 'fd-rights' : (blobData._dataType === 'base64' ? 'base64' : 'identity'))) : 'identity';
    const mimeType = (typeof blobData === 'object' && blobData !== null && blobData.type) ? blobData.type : 'application/json';

    const hostname = os.hostname();
    const display = (process.env.DISPLAY || ':0').replace(/^:/, '');
    const widHex = typeof senderWin === 'number' ? `0x${senderWin.toString(16)}` : String(senderWin);

    const headers = {
      'Content-Type': mimeType,
      'Content-Length': bodyBuf.length,
      'Content-Encoding': contentEncoding,
      'Accept-Encoding': 'identity, base64, fd-rights',
      'Origin': `${hostname}:${display}/${widHex}`
    };
    if (typeof blobData === 'object' && blobData !== null) {
      if (blobData.name) headers['Content-Disposition'] = `attachment; filename="${blobData.name}"`;
      if (blobData.xblobType) headers['X-XBlob-Type'] = blobData.xblobType;
    }

    const pathStr = targetBlobId ? `/blobs/${toHexBlobId(targetBlobId)}` : '/blobs';

    const req = http.request({
      socketPath: sockPath,
      path: pathStr,
      method: 'PUT',
      headers
    }, (res) => {
      let resData = '';
      res.on('data', chunk => { resData += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(resData);
          const rawBlob = res.headers['x-blob-id'] || json.blobId || json.blob || targetBlobId;
          const blobId = typeof rawBlob === 'number' ? rawBlob : (typeof rawBlob === 'string' && (rawBlob.startsWith('0x') || rawBlob.startsWith('0X')) ? parseInt(rawBlob, 16) : Number(rawBlob));
          if (!isNaN(blobId) && blobId > 0) {
            resolve(blobId);
          } else {
            reject(new Error('Invalid blob ID returned from socket: ' + resData));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.setTimeout(5000, () => {
      req.destroy(new Error('Socket PUT /blobs timeout'));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function httpPutBlobsOverHttp(port, blobData, senderWin, targetBlobId = null) {
  return new Promise((resolve, reject) => {
    let bodyBuf;
    if (Buffer.isBuffer(blobData)) {
      bodyBuf = blobData;
    } else if (typeof blobData === 'string') {
      bodyBuf = Buffer.from(blobData, 'utf8');
    } else if (typeof blobData === 'object' && blobData !== null) {
      if (blobData._dataType === 'binary' && Buffer.isBuffer(blobData.data)) {
        bodyBuf = blobData.data;
      } else {
        bodyBuf = Buffer.from(formatXBlobAtRest(blobData), 'utf8');
      }
    } else {
      bodyBuf = Buffer.from(String(blobData), 'utf8');
    }

    const contentEncoding = (typeof blobData === 'object' && blobData !== null) ? (blobData.contentEncoding || (blobData._dataType === 'fd-rights' ? 'fd-rights' : (blobData._dataType === 'base64' ? 'base64' : 'identity'))) : 'identity';
    const mimeType = (typeof blobData === 'object' && blobData !== null && blobData.type) ? blobData.type : 'application/json';

    const hostname = os.hostname();
    const display = (process.env.DISPLAY || ':0').replace(/^:/, '');
    const widHex = typeof senderWin === 'number' ? `0x${senderWin.toString(16)}` : String(senderWin);

    const headers = {
      'Content-Type': mimeType,
      'Content-Length': bodyBuf.length,
      'Content-Encoding': contentEncoding,
      'Accept-Encoding': 'identity, base64, fd-rights',
      'Origin': `${hostname}:${display}/${widHex}`
    };
    if (typeof blobData === 'object' && blobData !== null) {
      if (blobData.name) headers['Content-Disposition'] = `attachment; filename="${blobData.name}"`;
      if (blobData.xblobType) headers['X-XBlob-Type'] = blobData.xblobType;
    }

    const pathStr = targetBlobId ? `/blobs/${toHexBlobId(targetBlobId)}` : '/blobs';

    const req = http.request({
      hostname: 'localhost',
      port,
      path: pathStr,
      method: 'PUT',
      headers
    }, (res) => {
      let resData = '';
      res.on('data', chunk => { resData += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(resData);
          const rawBlob = res.headers['x-blob-id'] || json.blobId || json.blob || targetBlobId;
          const blobId = typeof rawBlob === 'number' ? rawBlob : (typeof rawBlob === 'string' && (rawBlob.startsWith('0x') || rawBlob.startsWith('0X')) ? parseInt(rawBlob, 16) : Number(rawBlob));
          if (!isNaN(blobId) && blobId > 0) {
            resolve(blobId);
          } else {
            reject(new Error('Invalid blob ID returned from http: ' + resData));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.setTimeout(5000, () => {
      req.destroy(new Error('HTTP PUT /blobs timeout'));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function XBlobCreate(
  X,
  routerWin,
  senderWin,
  blobData,
  timeoutMs = 5000
) {
  try {
    const hostname = os.hostname();
    const hostAtom = atoms[`XBLOB_HOST_${hostname}`] || (await X.InternAtom(false, `XBLOB_HOST_${hostname}`));
    const xblobHost = (await X.GetSelectionOwner(hostAtom)) || routerWin;
    const sockPath = (await getXBlobSocketPath(X, xblobHost)) || process.env.XBLOB_SOCKET_PATH;

    if (sockPath && fs.existsSync(sockPath)) {
      try {
        const blobId = await httpPutBlobsOverSocket(sockPath, blobData, senderWin);
        if (blobId) return blobId;
      } catch (sockErr) {
        logger.warn(`XBlobCreate socket PUT /blobs failed, falling back to X11 IPC: ${sockErr.message}`);
      }
    }
  } catch (_) {}

  let typeAtom = 0;
  if (blobData && typeof blobData === 'object') {
    const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'text/plain');
    if (mimeType) {
      typeAtom = atoms[mimeType] || (await X.InternAtom(false, mimeType));
      if (typeAtom) atoms[mimeType] = typeAtom;
    }
  }

  const cookie = crypto.randomBytes(4).readUInt32LE(0);
  const evBuf = buildClientMessageBuffer(routerWin, atoms.XBLOB_CREATE_V0, [
    senderWin,
    cookie,
    typeAtom || 0,
  ]);
  const responseEv = await X.seekResponsePacket(
    (ev) =>
      ev &&
      ev.type === 33 &&
      ev.message_type === atoms.XBLOB_CREATE_RESPONSE_V0 &&
      ev.data &&
      ((ev.data[2] >>> 0) === (cookie >>> 0)),
    timeoutMs
  ).SendEvent(routerWin, false, x11.eventMask.NoEventMask, evBuf);

  const blobId = responseEv.data[1];
  await XBlobWrite(X, routerWin, senderWin, blobId, blobData, os.hostname(), null);

  return blobId;
}

async function XBlobGrant(X, routerWin, senderWin, blobId, granteeWin) {
  return XClientMessage(X, routerWin, atoms.XBLOB_GRANT_V0, [
    senderWin,
    blobId,
    granteeWin,
  ]);
}

async function XBlobUnlink(X, routerWin, senderWin, blobId) {
  logger.debug(`XBlobUnlink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobId)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_UNLINK_V0, [
    senderWin,
    blobId,
  ]);
}

async function XBlobSoftLink(X, routerWin, senderWin, blobId) {
  logger.debug(`XBlobSoftLink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobId)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_SOFT_LINK_V0, [
    senderWin,
    blobId,
  ]);
}

async function XBlobSoftUnlink(X, routerWin, senderWin, blobId) {
  logger.debug(`XBlobSoftUnlink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobId)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_SOFT_UNLINK_V0, [
    senderWin,
    blobId,
  ]);
}

async function XBlobAnnounceHost(X, routerWin, senderWin, blobId, hostWin) {
  logger.debug(`XBlobAnnounceHost(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobId)}, ${widString(hostWin)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_ANNOUNCE_HOST_V0, [
    senderWin || 0,
    blobId || 0,
    hostWin || senderWin || 0,
  ]);
}

async function XBlobDropHost(X, routerWin, senderWin, blobId, hostWin) {
  logger.debug(`XBlobDropHost(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobId)}, ${widString(hostWin)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_DROP_HOST_V0, [
    senderWin || 0,
    blobId || 0,
    hostWin || senderWin || 0,
  ]);
}

async function XBlobBroadcast(X, routerWin, senderWin, blobId, host, version) {
  const targetWin = routerWin || senderWin || 0;
  logger.debug(`XBlobBroadcast(X, ${widString(targetWin)}, ${widString(senderWin || 0)}, ${widString(blobId || 0)})`);
  return XClientMessage(X, targetWin, atoms.XBLOB_BROADCAST_V0, [
    senderWin || 0,
    blobId || 0,
    host,
    version,
  ]);
}

function formatXBlobAtRest(blobData) {
  if (blobData === null || blobData === undefined) {
    blobData = {};
  }

  let xblobType = 'Blob';
  let type = null;
  let size = null;
  let name = null;
  let dataType = null;
  let bodyBuf = Buffer.alloc(0);

  const isWrapper = typeof blobData === 'object' && blobData !== null && !Buffer.isBuffer(blobData) && (blobData.data !== undefined || blobData.xblobType !== undefined);

  if (isWrapper) {
    if (blobData.xblobType) xblobType = blobData.xblobType;
    if (blobData.name) name = blobData.name;
    if (blobData.type) type = blobData.type;
    if (blobData.size !== undefined) size = blobData.size;
    if (blobData._dataType) dataType = blobData._dataType;

    if (Buffer.isBuffer(blobData.data)) {
      bodyBuf = blobData.data;
      if (!dataType) dataType = 'binary';
    } else if (typeof blobData.data === 'object' && blobData.data !== null) {
      bodyBuf = Buffer.from(JSON.stringify(blobData.data), 'utf8');
      if (!dataType) dataType = 'json';
    } else {
      bodyBuf = Buffer.from(String(blobData.data ?? ''), 'utf8');
    }
  } else if (typeof blobData === 'object' && blobData !== null && !Buffer.isBuffer(blobData)) {
    bodyBuf = Buffer.from(JSON.stringify(blobData), 'utf8');
    dataType = 'json';
    type = 'application/json';
  } else if (Buffer.isBuffer(blobData)) {
    bodyBuf = blobData;
    dataType = 'binary';
  } else {
    bodyBuf = Buffer.from(String(blobData), 'utf8');
  }

  if (!dataType) {
    if (type && (type.includes('application/json') || type.endsWith('+json'))) {
      dataType = 'json';
    } else {
      dataType = 'text';
    }
  }

  if (!type) {
    if (dataType === 'json') {
      type = 'application/json';
    } else if (dataType === 'base64' || dataType === 'binary') {
      type = 'application/octet-stream';
    } else {
      type = 'text/plain';
    }
  }

  if (size === null || size === undefined) {
    size = bodyBuf.length;
  }

  const headers = [];
  headers.push(`Content-Type: ${type}`);
  headers.push(`Content-Length: ${size}`);
  const contentEnc = blobData.contentEncoding || (dataType === 'fd-rights' || blobData._dataType === 'fd-rights' ? 'fd-rights' : (dataType === 'base64' ? 'base64' : null));
  if (contentEnc && contentEnc !== 'identity') {
    headers.push(`Content-Encoding: ${contentEnc}`);
  }
  const acceptEnc = blobData.acceptEncoding || (blobData.headers && (blobData.headers['accept-encoding'] || blobData.headers['Accept-Encoding']));
  if (acceptEnc) {
    headers.push(`Accept-Encoding: ${acceptEnc}`);
  }
  if (name) {
    headers.push(`Content-Disposition: attachment; filename="${name}"`);
    if (!blobData.xblobType) xblobType = 'File';
  }
  headers.push(`X-XBlob-Type: ${xblobType}`);

  if (typeof blobData === 'object' && blobData !== null) {
    const extraHeaders = blobData.headers || blobData.messageHeaders;
    if (extraHeaders && typeof extraHeaders === 'object') {
      Object.entries(extraHeaders).forEach(([k, v]) => {
        const lowerK = k.toLowerCase();
        if (!['content-type', 'content-length', 'content-encoding', 'accept-encoding', 'content-disposition', 'x-xblob-type'].includes(lowerK)) {
          headers.push(`${k}: ${v}`);
        }
      });
    }
  }

  const headerBuf = Buffer.from(headers.join('\r\n') + '\r\n\r\n', 'utf8');
  return Buffer.concat([headerBuf, bodyBuf]);
}

function parseXBlobAtRest(raw) {
  if (!raw) {
    return {
      xblobType: 'Blob',
      type: 'text/plain',
      size: 0,
      name: null,
      headers: {},
      data: Buffer.alloc(0),
      _dataType: 'text',
    };
  }

  const rawBuf = Buffer.isBuffer(raw) ? raw : (Array.isArray(raw) ? Buffer.from(raw) : Buffer.from(String(raw), 'utf8'));
  let sepPos = rawBuf.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (sepPos === -1) {
    sepPos = rawBuf.indexOf('\n\n');
    sepLen = 2;
  }

  let headerText = '';
  let bodyBuf = Buffer.alloc(0);

  if (sepPos !== -1) {
    headerText = rawBuf.slice(0, sepPos).toString('utf8');
    bodyBuf = rawBuf.slice(sepPos + sepLen);
  } else {
    headerText = rawBuf.toString('utf8');
  }

  const headers = {};
  headerText.split(/\r?\n/).forEach((line) => {
    const colonPos = line.indexOf(':');
    if (colonPos !== -1) {
      const key = line.slice(0, colonPos).trim().toLowerCase();
      const val = line.slice(colonPos + 1).trim();
      headers[key] = val;
    }
  });

  const contentType = headers['content-type'] || 'application/octet-stream';
  let size = headers['content-length'] ? parseInt(headers['content-length'], 10) : bodyBuf.length;
  if (isNaN(size)) size = bodyBuf.length;

  let name = null;
  const contentDisp = headers['content-disposition'];
  if (contentDisp) {
    const fnMatch = contentDisp.match(/filename\s*=\s*"?([^";]+)"?/i);
    if (fnMatch) name = fnMatch[1];
  }

  let xblobType = headers['x-xblob-type'] || headers['x-blob-type'] || 'Blob';
  const transferEnc = headers['content-encoding'] || headers['content-transfer-encoding'];
  let dataType = 'binary';

  let data = bodyBuf;
  if (transferEnc) {
    const lowerEnc = transferEnc.toLowerCase().trim();
    if (lowerEnc.includes('fd-rights')) {
      dataType = 'fd-rights';
      data = bodyBuf.toString('utf8').trim();
    } else if (lowerEnc.includes('base64')) {
      try {
        data = Buffer.from(bodyBuf.toString('utf8').trim(), 'base64');
        dataType = 'binary';
      } catch (_) {
        data = bodyBuf.toString('utf8');
        dataType = 'base64';
      }
    } else if (lowerEnc.includes('identity')) {
      data = bodyBuf.toString('utf8');
      dataType = 'text';
    }
  } else if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      data = JSON.parse(bodyBuf.toString('utf8'));
      dataType = 'json';
    } catch (_) {
      data = bodyBuf.toString('utf8');
      dataType = 'text';
    }
  } else if (contentType.startsWith('text/')) {
    data = bodyBuf.toString('utf8');
    dataType = 'text';
  }

  return {
    xblobType,
    type: contentType,
    size,
    name,
    headers,
    data,
    _dataType: dataType,
    contentEncoding: transferEnc || (dataType === 'fd-rights' ? 'fd-rights' : (dataType === 'base64' ? 'base64' : 'identity')),
  };
}

async function XBlobWrite(X, routerWin, senderWin, blobId, blobData, host, version) {
  if (version && typeof blobData === 'object' && blobData !== null) {
    blobData = Object.assign({}, blobData, { version });
  }
  const hexBlobId = typeof blobId === 'number' ? `0x${blobId.toString(16)}` : String(blobId);
  const hostname = os.hostname();
  const hostAtom = atoms[`XBLOB_HOST_${hostname}`] || (await X.InternAtom(false, `XBLOB_HOST_${hostname}`));
  const selectionOwner = await X.GetSelectionOwner(hostAtom);
  const xblobHost = selectionOwner || senderWin || routerWin;

  // Send blob to XBlob host via HTTP over socket or HTTP port
  const sockPath = (await getXBlobSocketPath(X, xblobHost)) || process.env.XBLOB_SOCKET_PATH;
  if (sockPath && fs.existsSync(sockPath)) {
    try {
      await httpPutBlobsOverSocket(sockPath, blobData, senderWin || xblobHost, blobId);
      return;
    } catch (sockErr) {
      logger.warn(`XBlobWrite socket PUT /blobs/${hexBlobId} failed: ${sockErr.message}`);
    }
  }

  const httpPort = parseInt(process.env.XINTENT_PORT || process.env.PORT || '12345', 10);
  try {
    await httpPutBlobsOverHttp(httpPort, blobData, senderWin || xblobHost, blobId);
  } catch (httpErr) {
    logger.error(`XBlobWrite HTTP PUT /blobs/${hexBlobId} failed: ${httpErr.message}`);
  }
}


async function XBlobTransfer(X, routerWin, senderWin, blobId, granteeWin) {
  return XClientMessage(X, routerWin, atoms.XBLOB_TRANSFER_V0, [
    senderWin,
    blobId,
    granteeWin,
  ]);
}

const sendXChannelJsonFrame = async (
  messageTypeAtom,
  X,
  routerWin,
  { targetWin, senderWin, txId, channel, controlWord, payload, payloadBlob, dataBlob, unlinkPayloadBlob = true }
) => {
  if (!targetWin) {
    targetWin = routerWin;
  }

  // 1. Create payload blob if not provided
  if (!payloadBlob) {
    const payloadWrapper = (typeof payload === 'object' && payload !== null && payload.data === undefined && payload.xblobType === undefined)
      ? { xblobType: 'Blob', type: 'application/json', data: payload }
      : payload;
    payloadBlob = await XBlobCreate(X, routerWin, senderWin, payloadWrapper);
  }

  // 2. Transfer or Grant blob rights BEFORE dispatching message
  if (targetWin !== senderWin) {
    if (unlinkPayloadBlob) {
      await XBlobTransfer(X, routerWin, senderWin, payloadBlob, targetWin);
      if (dataBlob) {
        await XBlobTransfer(X, routerWin, senderWin, dataBlob, targetWin);
      }
    } else {
      await XBlobGrant(X, routerWin, senderWin, payloadBlob, targetWin);
      if (dataBlob) {
        await XBlobGrant(X, routerWin, senderWin, dataBlob, targetWin);
      }
    }
  }

  if (txId !== undefined && txId > 16777215) {
    logger.error("txId above 16777216", { txId, channel });
  }
  if (channel !== undefined && (channel != 0 && channel < 16777216)) {
    logger.error("channel under 16777216", { txId, channel });
  }
  if (txId !== undefined && channel !== undefined) {
    logger.error("only allowed to specify one of txId, channel", { txId, channel });
  }

  const channelToSend = (channel !== undefined && channel !== 0) ? (channel >>> 0) : (txId !== undefined ? (txId >>> 0) : 0);
  const ctrlWordToSend = (controlWord !== undefined ? controlWord : 0) >>> 0;

  // 3. Dispatch XChannelJsonFrame: data.l[0]=senderWin, data.l[1]=channel, data.l[2]=controlWord, data.l[3]=payloadBlob, data.l[4]=dataBlob
  await XClientMessage(X, targetWin, messageTypeAtom, [
    (senderWin || routerWin) >>> 0,
    channelToSend,
    ctrlWordToSend,
    (payloadBlob >>> 0),
    (dataBlob || 0) >>> 0,
  ]);

  logger.info(
    `Dispatched XChannelJsonFrame (atom ${messageTypeAtom}) to ${widString(targetWin)} (channel ${channelToSend}, ctrl ${ctrlWordToSend}, payload blob ${widString(payloadBlob)}${dataBlob ? `, data blob ${widString(dataBlob)}` : ''})`
  );
  return payloadBlob;
};

// Protocol-specific wrappers
const sendXIntentIntentV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(atoms.XINTENT_INTENT_V0, X, routerWin, opts);

const sendXIntentEventV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(atoms.XINTENT_EVENT_V0, X, routerWin, opts);

const sendXAudioPlayV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(atoms.XAUDIO_PLAY_V0, X, routerWin, opts);

const sendXAudioPlayResponseV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(atoms.XAUDIO_PLAY_RESPONSE_V0, X, routerWin, opts);

const sendXAudioControlV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(atoms.XAUDIO_CONTROL_V0, X, routerWin, opts);

function httpGetBlobOverSocket(sockPath, hexBlobId) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: sockPath,
      path: `/blobs/${hexBlobId}`,
      method: 'GET',
      headers: {
        'Accept': '*/*',
        'Accept-Encoding': 'identity, base64, fd-rights'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const bodyBuf = Buffer.concat(chunks);
          const headers = [];
          if (res.headers['content-type']) headers.push(`Content-Type: ${res.headers['content-type']}`);
          if (res.headers['content-length']) headers.push(`Content-Length: ${res.headers['content-length']}`);
          if (res.headers['content-encoding']) headers.push(`Content-Encoding: ${res.headers['content-encoding']}`);
          if (res.headers['content-disposition']) headers.push(`Content-Disposition: ${res.headers['content-disposition']}`);
          if (res.headers['x-xblob-type']) headers.push(`X-XBlob-Type: ${res.headers['x-xblob-type']}`);

          const rawRest = Buffer.concat([
            Buffer.from(headers.join('\r\n') + '\r\n\r\n', 'utf8'),
            bodyBuf
          ]);
          try {
            resolve(parseXBlobAtRest(rawRest));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`GET /blobs/${hexBlobId} over socket returned status ${res.statusCode}`));
        }
      });
    });

    req.setTimeout(5000, () => {
      req.destroy(new Error(`Socket GET /blobs/${hexBlobId} timeout`));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpGetBlobOverHttp(port, hexBlobId) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port,
      path: `/blobs/${hexBlobId}`,
      method: 'GET',
      headers: {
        'Accept': '*/*',
        'Accept-Encoding': 'identity, base64, fd-rights'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const bodyBuf = Buffer.concat(chunks);
          const headers = [];
          if (res.headers['content-type']) headers.push(`Content-Type: ${res.headers['content-type']}`);
          if (res.headers['content-length']) headers.push(`Content-Length: ${res.headers['content-length']}`);
          if (res.headers['content-encoding']) headers.push(`Content-Encoding: ${res.headers['content-encoding']}`);
          if (res.headers['content-disposition']) headers.push(`Content-Disposition: ${res.headers['content-disposition']}`);
          if (res.headers['x-xblob-type']) headers.push(`X-XBlob-Type: ${res.headers['x-xblob-type']}`);

          const rawRest = Buffer.concat([
            Buffer.from(headers.join('\r\n') + '\r\n\r\n', 'utf8'),
            bodyBuf
          ]);
          try {
            resolve(parseXBlobAtRest(rawRest));
          } catch (e) {
            reject(e);
          }
        } else {
          reject(new Error(`GET /blobs/${hexBlobId} over HTTP returned status ${res.statusCode}`));
        }
      });
    });

    req.setTimeout(5000, () => {
      req.destroy(new Error(`HTTP GET /blobs/${hexBlobId} timeout`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function XBlobRead(X, routerWin, blobId, host, version) {
  const hexBlobId = typeof blobId === 'number' ? `0x${blobId.toString(16)}` : String(blobId);

  let hostWin = routerWin;
  if (typeof host === 'number' && host > 0) {
    hostWin = host;
  } else {
    try {
      const hostname = os.hostname();
      const hostAtom = atoms[`XBLOB_HOST_${hostname}`] || (await X.InternAtom(false, `XBLOB_HOST_${hostname}`));
      const selOwner = await X.GetSelectionOwner(hostAtom);
      if (selOwner) hostWin = selOwner;
    } catch (_) {}
  }

  // 1. Try socket GET
  try {
    const sockPath = (await getXBlobSocketPath(X, hostWin)) || process.env.XBLOB_SOCKET_PATH;
    if (sockPath && fs.existsSync(sockPath)) {
      try {
        const blobData = await httpGetBlobOverSocket(sockPath, hexBlobId);
        if (blobData) return blobData;
      } catch (sockErr) {
        logger.warn(`XBlobRead socket GET /blobs/${hexBlobId} failed: ${sockErr.message}`);
      }
    }
  } catch (_) {}

  // 2. Try HTTP port GET
  const httpPort = parseInt(process.env.XINTENT_PORT || process.env.PORT || '12345', 10);
  try {
    const blobData = await httpGetBlobOverHttp(httpPort, hexBlobId);
    if (blobData) return blobData;
  } catch (httpErr) {
    logger.warn(`XBlobRead HTTP GET /blobs/${hexBlobId} failed: ${httpErr.message}`);
  }

  throw new Error(`XBlobRead: blob ${hexBlobId} not found on XBlob host`);
}

async function parseJsonFrame(X, routerWin, ev, {unlinkPayloadBlob = true}={}) {
  const senderWin = ev.data[0];
  const payloadBlob = ev.data[3] || ev.data[1]; // data.l[3] for XChannelJsonFrame, fallback data.l[1] for XJsonFrame
  logger.setContext({
    sender: widString(senderWin),
    payloadBlob: widString(payloadBlob)
  });
  const rawBlob = await XBlobRead(X, routerWin, payloadBlob);
  let payload = rawBlob;
  const headers = rawBlob?.headers || {};
  if (rawBlob && typeof rawBlob === 'object' && rawBlob.data !== undefined) {
    payload = rawBlob.data;
  }
  if (payload && typeof payload === 'object' && !payload.intent && !payload.event && !payload.action && payload.data !== undefined && typeof payload.data === 'object') {
    payload = payload.data;
  }
  if (payload && typeof payload === 'object') {
    const cmd = payload.intent || payload.event || payload.action;
    if (cmd) {
      logger.setContext({ command: cmd });
    }
  }
  if(unlinkPayloadBlob){
    XBlobUnlink(X, routerWin, ev.wid, payloadBlob);
  }
  return { targetWin: ev.wid, senderWin, payload, payloadBlob, headers };
}

async function parseXIntentIntentV0(X, routerWin, ev, {unlinkPayloadBlob = true} = {}) {
  const { senderWin, payload, payloadBlob, headers } = await parseJsonFrame(
    X,
    routerWin,
    ev,
    {unlinkPayloadBlob}
  );
  const channel = ev.data[1];
  const controlWord = ev.data[2];
  const dataBlob = ev.data[4];
  const messageTypeAtom = ev.message_type;
  return { targetWin: ev.wid, senderWin, channel, controlWord, payload, payloadBlob, dataBlob, messageTypeAtom, headers };
}

function parseXBlobBroadcastFrame(X, routerWin, ev){
  return {
    blob: ev.data[1],
    host: ev.data[2],
    version: ev.data[3],
  }
}

function parseXBlobDestructorFrame(X, routerWin, ev) {
  return {
    blob: ev.data[1],
  }
}


function getAtomName(atomId) {
  if (typeof atomId === 'string' && atomId.length > 0) return atomId;
  if (typeof atomId === 'number') {
    for (const [name, val] of Object.entries(atoms)) {
      if (val === atomId) return name;
    }
    return `ATOM_${atomId}`;
  }
  return 'FRAME';
}

function frameType(msg) {
  if (!msg) return 'UNKNOWN_FRAME';

  const atomId = msg.messageTypeAtom || msg.message_type || msg.messageType || msg.type || msg.atom;
  const atomName = getAtomName(atomId);

  const payload = msg.payload || (typeof msg === 'object' ? msg : {});
  const actionName = payload?.intent || payload?.event || payload?.action || (payload?.data && typeof payload.data === 'object' ? (payload.data.intent || payload.data.event || payload.data.action) : undefined);

  if (actionName) {
    return `${atomName}:${actionName}`;
  }
  return atomName;
}

function formatControlWord(cw) {
  if (cw === undefined || cw === null) return '';
  const num = Number(cw);
  const flags = [];
  if (num & 1) flags.push('SYN');
  if (num & 2) flags.push('FIN');
  return flags.length > 0 ? flags.join(',') : String(num);
}

function frameDesc(msg) {
  if (!msg) return 'UNKNOWN_FRAME';

  const sender = msg.senderWin || msg.sender || 0;
  const target = msg.targetWin || msg.target || msg.wid || 0;
  const cw = msg.controlWord !== undefined ? msg.controlWord : msg.ctrl;
  const channel = msg.channel !== undefined ? msg.channel : msg.txId;

  let ctrlStr = '';
  if (cw !== undefined || (channel !== undefined && channel !== 0)) {
    const channelPart = (channel !== undefined && channel !== 0) ? `${channel}:` : '';
    const cwPart = cw !== undefined ? formatControlWord(cw) : '';
    ctrlStr = `[${channelPart}${cwPart}]`;
  }

  const fType = frameType(msg);

  return `${widString(sender)} - ${ctrlStr}${fType} -> ${widString(target)}`;
}

const SYN = 1;
const FIN = 2;
const SYN_FIN = 3;

async function getXBlobSocketPath(X, hostWin) {
  if (!hostWin) return null;
  const socketPathAtom = atoms['XBLOB_SOCKET_PATH'] || (await X.InternAtom(false, 'XBLOB_SOCKET_PATH'));
  try {
    const prop = await X.GetProperty(0, hostWin, socketPathAtom, 0, 0, 1024);
    if (prop && prop.data && prop.data.length > 0) {
      return prop.data.toString('utf8');
    }
  } catch (_) {}
  return null;
}

module.exports = {
  x11,
  SYN,
  FIN,
  SYN_FIN,
  init,
  connectToRouter,
  waitForRouterWin,
  getValidRouterWin,
  createClientWindow,
  atoms,
  widString,
  frameType,
  frameDesc,
  parseJsonFrame,
  parseXIntentIntentV0,
  parseXIntentEventV0: parseXIntentIntentV0,
  parseXBlobBroadcastFrame,
  parseXBlobDestructorFrame,
  buildClientMessageBuffer,
  XClientMessage,
  sendXChannelJsonFrame,
  sendXIntentIntentV0,
  sendXIntentEventV0,
  sendXAudioPlayV0,
  sendXAudioPlayResponseV0,
  sendXAudioControlV0,
  XBlobCreate,
  XBlobGrant,
  XBlobUnlink,
  XBlobSoftLink,
  XBlobSoftUnlink,
  XBlobAnnounceHost,
  XBlobDropHost,
  XBlobTransfer,
  XBlobRead,
  XBlobWrite,
  XBlobBroadcast,
  formatXBlobAtRest,
  parseXBlobAtRest,
  getXBlobSocketPath,
};