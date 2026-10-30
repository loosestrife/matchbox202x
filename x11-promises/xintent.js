const fs = require("fs");
const os = require("os");
const x11 = require("./x11-promises");
const { formatXBlobAtRest, parseXBlobAtRest } = require("./xintent-at-rest");
const {
  buildXBlobUserAgent,
  httpPutBlobsOverSocket,
  httpPutBlobsOverHttp,
  httpGetBlobOverSocket,
  httpGetBlobOverHttp,
  getXBlobSocketPath: rawGetXBlobSocketPath,
} = require("./xintent-blob-http");
const {
  SYN,
  FIN,
  SYN_FIN,
  widString,
  setFrameContext,
  buildClientMessageBuffer,
  XClientMessage,
  sendXChannelJsonFrame,
  sendXIntentIntentV0,
  sendXIntentEventV0,
  sendXAudioPlayV0,
  sendXAudioPlayResponseV0,
  sendXAudioControlV0,
  parseJsonFrame,
  parseXIntentIntentV0,
  parseXBlobBroadcastFrame,
  parseXBlobDestructorFrame,
  parseXBlobStreamClosedFrame,
  frameType,
  frameDesc,
} = require("./xintent-frames");

let Logger;
try {
  const serverTools = require("../server-tools");
  Logger = serverTools.Logger;
} catch (_) {}

const createConsoleLogger = (moduleName = "xintent") => ({
  info: (...args) => console.log(`[${moduleName} info]`, ...args),
  warn: (...args) => console.warn(`[${moduleName} warn]`, ...args),
  error: (...args) => console.error(`[${moduleName} error]`, ...args),
  debug: (...args) => (console.debug ? console.debug(`[${moduleName} debug]`, ...args) : console.log(`[${moduleName} debug]`, ...args)),
  log: (...args) => console.log(`[${moduleName}]`, ...args),
  setContext: () => {},
});

let logger = Logger ? new Logger({ module: "xintent" }) : createConsoleLogger("xintent");

function init(options = {}) {
  if (options.logger) {
    logger = options.logger;
  }
  return { logger };
}

const atoms = {};

const REQUIRED_ATOMS = ["XCHANNEL", "XINTENT", "XINTENT_INTENT_V0"];

const PROTOCOL_ATOMS = [
  "STRING",
  "WINDOW",
  "WM_NAME",
  "WM_CLASS",
  "_NET_WM_PID",
  "CARDINAL",
  "MATCHBOX_TOML",
  "AGGREGATE_TOML",
  "SERVICE_MANIFEST_TOML",
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
  "XBLOB_STREAM_CLOSED_V0",
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

async function findCandidateRouterWin(X) {
  const fromChannel = atoms.XCHANNEL ? await X.GetSelectionOwner(atoms.XCHANNEL) : 0;
  if (fromChannel) return fromChannel;
  return atoms.XINTENT ? await X.GetSelectionOwner(atoms.XINTENT) : 0;
}

function isRouterWindowName(wName) {
  return wName === "XCHANNEL_BUSMASTER" || wName === "XINTENT_ROUTER";
}

async function getRouterWin(X, root) {
  try {
    const candidateRouterWin = await findCandidateRouterWin(X);
    if (!candidateRouterWin) {
      module.exports.routerWin = undefined;
      return null;
    }
    await X.GetWindowAttributes(candidateRouterWin);
    const nameProp = await X.GetProperty(0, candidateRouterWin, atoms.WM_NAME, atoms.STRING, 0, 20);
    const wName = nameProp && nameProp.data ? nameProp.data.toString("utf8").trim() : "";
    if (!isRouterWindowName(wName)) {
      module.exports.routerWin = undefined;
      return null;
    }
    module.exports.routerWin = candidateRouterWin;
    return candidateRouterWin;
  } catch (_) {
    module.exports.routerWin = undefined;
    return null;
  }
}

function isRouterPropertyNotify(ev, root) {
  if (!ev || ev.name !== "PropertyNotify" || ev.wid !== root) return false;
  return ev.atom === atoms.XINTENT || ev.atom === atoms.XCHANNEL;
}

function attachRouterWatcher(X, root) {
  if (module.exports._hasXIntentListener) return;
  module.exports._hasXIntentListener = true;
  try {
    X.ChangeWindowAttributes(root, { eventMask: x11.eventMask.PropertyChange });
  } catch (_) {}
  X.on("event", async (ev) => {
    if (ev.name === "DestroyNotify" && ev.wid == module.exports.routerWin) {
      module.exports.routerWin = undefined;
    }
    if (isRouterPropertyNotify(ev, root)) {
      await getRouterWin(X, root);
    }
  });
}

async function connectToRouter(X, root, timeoutMs = 0) {
  const requiredResults = await Promise.all(
    REQUIRED_ATOMS.map(async (atomName) => {
      const atom = await X.InternAtom(false, atomName);
      if (!atom) logger.warn(`required atom ${atomName} not on server`);
      atoms[atomName] = atom;
      return atom;
    })
  );
  if (requiredResults.some((atom) => !atom)) {
    return 0;
  }

  await Promise.all(
    PROTOCOL_ATOMS.map(async (atomName) => {
      atoms[atomName] = await X.InternAtom(false, atomName);
    })
  );

  attachRouterWatcher(X, root);
  return await waitForRouterWin(X, root, timeoutMs);
}

function awaitRouterWinDiscovery(X, root, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;
    let pollInterval = null;

    const finish = (win) => {
      if (resolved) return;
      resolved = true;
      if (pollInterval) clearInterval(pollInterval);
      if (timer) clearTimeout(timer);
      X.removeListener("event", propertyHandler);
      resolve(win);
    };

    const tryResolveRouter = async () => {
      const candidate = await getRouterWin(X, root);
      if (candidate) finish(candidate);
    };

    const propertyHandler = async (ev) => {
      if (isRouterPropertyNotify(ev, root)) {
        await tryResolveRouter();
      }
    };

    X.on("event", propertyHandler);
    pollInterval = setInterval(tryResolveRouter, 250);
    timer = setTimeout(() => finish(module.exports.routerWin || null), timeoutMs);
  });
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

  return awaitRouterWinDiscovery(X, root, timeoutMs);
}

async function getValidRouterWin(X, root) {
  return await waitForRouterWin(X, root, 5000);
}

async function createClientWindow(X, root, name = "xintent-client") {
  const clientWin = X.AllocID();
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

async function getXBlobSocketPath(X, hostWin) {
  return rawGetXBlobSocketPath(X, hostWin, atoms);
}

async function getHostSelectionOwner(X) {
  const hostname = os.hostname();
  const hostAtom = atoms[`XBLOB_HOST_${hostname}`] || (await X.InternAtom(false, `XBLOB_HOST_${hostname}`));
  return await X.GetSelectionOwner(hostAtom);
}

async function XBlobCreate(X, routerWin, senderWin, blobData, timeoutMs = 5000) {
  const xblobHost = (await getHostSelectionOwner(X)) || routerWin;
  const sockPath = (await getXBlobSocketPath(X, xblobHost)) || process.env.XBLOB_SOCKET_PATH;

  if (sockPath && fs.existsSync(sockPath)) {
    const blobId = await httpPutBlobsOverSocket(sockPath, blobData, senderWin);
    if (blobId) return blobId;
  }

  const httpPort = parseInt(process.env.XINTENT_PORT || process.env.PORT || "12345", 10);
  return await httpPutBlobsOverHttp(httpPort, blobData, senderWin);
}

async function XBlobGrant(X, routerWin, senderWin, blobId, granteeWin) {
  return XClientMessage(X, routerWin, atoms.XBLOB_GRANT_V0, [senderWin, blobId, granteeWin]);
}

async function XBlobUnlink(X, routerWin, senderWin, blobId) {
  logger.debug(`XBlobUnlink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobId)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_UNLINK_V0, [senderWin, blobId]);
}

async function XBlobSoftLink(X, routerWin, senderWin, blobId) {
  logger.debug(`XBlobSoftLink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobId)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_SOFT_LINK_V0, [senderWin, blobId]);
}

async function XBlobSoftUnlink(X, routerWin, senderWin, blobId) {
  logger.debug(`XBlobSoftUnlink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobId)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_SOFT_UNLINK_V0, [senderWin, blobId]);
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

async function XBlobStreamClosed(X, routerWin, senderWin, blobId, host, size = 0) {
  const targetWin = routerWin || senderWin || 0;
  const numSize = Number(size) || 0;
  const sizeLow = numSize >>> 0;
  const sizeHigh = Math.floor(numSize / 0x100000000) >>> 0;
  logger.debug(`XBlobStreamClosed(X, ${widString(targetWin)}, ${widString(senderWin || 0)}, ${widString(blobId || 0)}, size=${numSize})`);
  return XClientMessage(X, targetWin, atoms.XBLOB_STREAM_CLOSED_V0, [
    senderWin || 0,
    blobId || 0,
    host || senderWin || 0,
    sizeLow,
    sizeHigh,
  ]);
}

async function XBlobWrite(X, routerWin, senderWin, blobId, blobData, host, version) {
  if (version && typeof blobData === "object" && blobData !== null) {
    blobData = Object.assign({}, blobData, { version });
  }
  const hexBlobId = typeof blobId === "number" ? `0x${blobId.toString(16)}` : String(blobId);
  const selectionOwner = await getHostSelectionOwner(X);
  const xblobHost = selectionOwner || senderWin || routerWin;
  const sockPath = (await getXBlobSocketPath(X, xblobHost)) || process.env.XBLOB_SOCKET_PATH;

  if (sockPath && fs.existsSync(sockPath)) {
    try {
      await httpPutBlobsOverSocket(sockPath, blobData, senderWin || xblobHost, blobId);
      return;
    } catch (sockErr) {
      logger.warn(`XBlobWrite socket PUT /blobs/${hexBlobId} failed: ${sockErr.message}`);
    }
  }

  const httpPort = parseInt(process.env.XINTENT_PORT || process.env.PORT || "12345", 10);
  try {
    await httpPutBlobsOverHttp(httpPort, blobData, senderWin || xblobHost, blobId);
  } catch (httpErr) {
    logger.error(`XBlobWrite HTTP PUT /blobs/${hexBlobId} failed: ${httpErr.message}`);
  }
}

async function XBlobTransfer(X, routerWin, senderWin, blobId, granteeWin) {
  return XClientMessage(X, routerWin, atoms.XBLOB_TRANSFER_V0, [senderWin, blobId, granteeWin]);
}

async function resolveXBlobHostWin(X, routerWin, host) {
  if (typeof host === "number" && host > 0) return host;
  try {
    const selOwner = await getHostSelectionOwner(X);
    if (selOwner) return selOwner;
  } catch (_) {}
  return routerWin;
}

async function fetchBlobFromHost(X, hostWin, hexBlobId, userAgent, acceptReadableStream = false) {
  try {
    const sockPath = (await getXBlobSocketPath(X, hostWin)) || process.env.XBLOB_SOCKET_PATH;
    if (sockPath && fs.existsSync(sockPath)) {
      return await httpGetBlobOverSocket(sockPath, hexBlobId, userAgent, acceptReadableStream);
    }
  } catch (sockErr) {
    logger.warn(`XBlobRead socket GET /blobs/${hexBlobId} failed: ${sockErr.message}`);
  }

  const httpPort = parseInt(process.env.XINTENT_PORT || process.env.PORT || "12345", 10);
  try {
    return await httpGetBlobOverHttp(httpPort, hexBlobId, userAgent, acceptReadableStream);
  } catch (httpErr) {
    logger.warn(`XBlobRead HTTP GET /blobs/${hexBlobId} failed: ${httpErr.message}`);
  }
  return null;
}

function hydrateBlobFileData(blobData) {
  if (typeof blobData.data === "string" && (blobData.data.startsWith("/proc/") || fs.existsSync(blobData.data))) {
    try {
      blobData.data = fs.readFileSync(blobData.data);
      blobData._dataType = "binary";
      blobData.contentEncoding = "identity";
    } catch (_) {}
  } else if (typeof blobData.data === "number" && blobData.data >= 0) {
    const fd = blobData.data;
    try {
      blobData.data = fs.readFileSync(`/proc/self/fd/${fd}`);
      blobData._dataType = "binary";
      blobData.contentEncoding = "identity";
    } catch (_) {
    } finally {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function applyReceiveFdOption(blobData, receiveFd, acceptReadableStream = false) {
  if (!receiveFd && !acceptReadableStream && blobData.xblobType !== "ReadableStream") {
    hydrateBlobFileData(blobData);
    return blobData;
  }
  if (typeof blobData.data === "string" && (blobData.data.startsWith("/proc/") || fs.existsSync(blobData.data))) {
    try {
      blobData.data = fs.openSync(blobData.data, "r");
      blobData._dataType = "fd-rights";
      blobData.contentEncoding = "fd-rights";
    } catch (_) {}
  }
  return blobData;
}

async function XBlobRead(X, routerWin, blobId, host, version, clientWin = 0, appId = "xintent", options = {}) {
  const receiveFd = (typeof options === "object" && options !== null) ? !!options.receiveFd : !!options;
  const acceptReadableStream = (typeof options === "object" && options !== null) ? !!options.acceptReadableStream : false;
  const hexBlobId = typeof blobId === "number" ? `0x${blobId.toString(16)}` : String(blobId);
  const userAgent = buildXBlobUserAgent(clientWin, appId);
  const hostWin = await resolveXBlobHostWin(X, routerWin, host);
  const blobData = await fetchBlobFromHost(X, hostWin, hexBlobId, userAgent, acceptReadableStream);

  if (blobData) {
    return applyReceiveFdOption(blobData, receiveFd, acceptReadableStream);
  }
  throw new Error(`XBlobRead: blob ${hexBlobId} not found on XBlob host`);
}

setFrameContext({
  atoms,
  getLogger: () => logger,
  XBlobCreate,
  XBlobTransfer,
  XBlobGrant,
  XBlobRead,
  XBlobUnlink,
});

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
  parseXBlobStreamClosedFrame,
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
  XBlobStreamClosed,
  formatXBlobAtRest,
  parseXBlobAtRest,
  getXBlobSocketPath,
};
