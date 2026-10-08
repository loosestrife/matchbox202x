const crypto = require("crypto");
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
    const candidateRouterWin = await X.GetSelectionOwner(atoms.XINTENT);
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
      14
    );
    if (
      !nameProp ||
      !nameProp.data ||
      nameProp.data.toString("utf8").trim() !== "XINTENT_ROUTER"
    ) {
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

async function connectToRouter(X, root) {
  const requiredAtoms = ["XINTENT", "XINTENT_INTENT_V0"];
  const requiredResults = await Promise.all(
    requiredAtoms.map(async (atomName) => {
      const atom = await X.InternAtom(true, atomName);
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
    'XINTENT_AGGREGATE_TOML',
    'XINTENT_SERVICES_MANIFEST',

    "XINTENT_EVENT_V0",
    "XBLOB_CREATE_V0",
    "XBLOB_CREATE_RESPONSE_V0",
    "XBLOB_GRANT_V0",
    "XBLOB_UNLINK_V0",
    "XBLOB_TRANSFER_V0",
    "XBLOB_BROADCAST_V0",
    "XBLOB_SOFT_LINK_V0",
    "XBLOB_SOFT_UNLINK_V0",
    "XBLOB_DESTRUCTOR_V0",

    "XAUDIO_PLAY_V0",
    "XAUDIO_CONTROL_V0",
    "XAUDIO_PREFETCH_SOUND_BLOB_V0",
    "XAUDIO_SEEK_STREAM_V0",
    "XAUDIO_GET_AUDIO_OUTPUTS_V0",
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
      if (ev.name === 'PropertyNotify' && ev.wid === root && ev.atom === atoms.XINTENT) {
        await getRouterWin(X, root);
      }
    });
  }

  return await waitForRouterWin(X, root, 5000);
}

async function waitForRouterWin(X, root, timeoutMs = 10000) {
  if (module.exports.routerWin) {
    try {
      await X.GetWindowAttributes(module.exports.routerWin);
      return module.exports.routerWin;
    } catch (_) {
      module.exports.routerWin = undefined;
    }
  }

  return new Promise((resolve) => {
    let resolved = false;
    let timer = null;

    const propertyHandler = async (ev) => {
      if (ev && ev.name === 'PropertyNotify' && ev.wid === root && ev.atom === atoms.XINTENT) {
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

async function XBlobCreate(
  X,
  routerWin,
  senderWin,
  blobData,
  timeoutMs = 5000
) {
  const cookie = crypto.randomBytes(4).readUInt32LE(0);
  const evBuf = buildClientMessageBuffer(routerWin, atoms.XBLOB_CREATE_V0, [
    senderWin,
    cookie,
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

  const blobAtom = responseEv.data[1];
  await XBlobWrite(X, routerWin, senderWin, blobAtom, blobData, os.hostname(), null);

  return blobAtom;
}

async function XBlobGrant(X, routerWin, senderWin, blobAtom, granteeWin) {
  return XClientMessage(X, routerWin, atoms.XBLOB_GRANT_V0, [
    senderWin,
    blobAtom,
    granteeWin,
  ]);
}

async function XBlobUnlink(X, routerWin, senderWin, blobAtom) {
  logger.debug(`XBlobUnlink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobAtom)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_UNLINK_V0, [
    senderWin,
    blobAtom,
  ]);
}

async function XBlobSoftLink(X, routerWin, senderWin, blobAtom) {
  logger.debug(`XBlobSoftLink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobAtom)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_SOFT_LINK_V0, [
    senderWin,
    blobAtom,
  ]);
}

async function XBlobSoftUnlink(X, routerWin, senderWin, blobAtom) {
  logger.debug(`XBlobSoftUnlink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobAtom)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_SOFT_UNLINK_V0, [
    senderWin,
    blobAtom,
  ]);
}

async function XBlobBroadcast(X, routerWin, senderWin, blobAtom, host, version) {
  logger.debug(`XBlobBroadcast(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobAtom)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_BROADCAST_V0, [
    senderWin,
    blobAtom,
    host,
    version,
  ]);
}

async function XBlobWrite(X, routerWin, senderWin, blobAtom, blobData, host, version){
  if(version){
    data.version = version; // todo: get the current verion and bump it
  }
  const hostname = os.hostname();
  const hostAtom = await X.InternAtom(false, `XBLOB_HOST_${hostname}`);
  const xblobHost = (await X.GetSelectionOwner(hostAtom)) || routerWin;
  const payloadString = Buffer.from(JSON.stringify(blobData, null, 2));
  const buffer = Buffer.from(payloadString, 'utf8');
  // Chunk size: 32,768 bytes (safely under the 65,535 X11 request unit limit)
  const CHUNK_SIZE = 32768;
  for (let offset = 0; offset < buffer.length; offset += CHUNK_SIZE) {
    const chunk = buffer.subarray(offset, offset + CHUNK_SIZE);
    // Mode 0 = PropModeReplace (first chunk resets/creates the prop)
    // Mode 2 = PropModeAppend  (subsequent chunks append)
    const mode = offset === 0 ? 0 : 2;
    X.ChangeProperty(
      mode,
      xblobHost,
      blobAtom,
      atoms.STRING,
      8,
      chunk
    );
  }
  X.SetSelectionOwner(xblobHost, blobAtom, 0);
}


async function XBlobTransfer(X, routerWin, senderWin, blobAtom, granteeWin) {
  return XClientMessage(X, routerWin, atoms.XBLOB_TRANSFER_V0, [
    senderWin,
    blobAtom,
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
    payloadBlob = await XBlobCreate(X, routerWin, senderWin, payload);
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
  const ctrlWordToSend = (controlWord !== undefined
    ? controlWord
    : (channelToSend !== 0 || payload?.reply || payload?.Accept ? 3 : 0)) >>> 0;

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
  sendXChannelJsonFrame(atoms.XAUDIO_PLAY_V0 || atoms.XAUDIO_PLAY_V0, X, routerWin, opts);

const sendXAudioControlV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(atoms.XAUDIO_CONTROL_V0 || atoms.XAUDIO_CONTROL_V0, X, routerWin, opts);

async function XBlobRead(X, routerWin, blobAtom, host, version) {
  let hostWin = await X.GetSelectionOwner(blobAtom);
  if (!hostWin) {
    hostWin = routerWin;
  }

  const prop = await X.GetProperty(
    0,
    hostWin,
    blobAtom,
    atoms.STRING,
    0,
    4_000_000_000
  );
  if (prop && prop.data) {
    const rawStr = prop.data.toString();
    try {
      return JSON.parse(rawStr);
    } catch (parseErr) {
      const snippet = rawStr.length > 200 ? rawStr.slice(0, 200) + '...' : rawStr;
      logger.setContext({
        blobAtom: widString(blobAtom),
        hostWin: widString(hostWin),
        rawLength: rawStr.length,
        rawSnippet: snippet
      });
      const err = new SyntaxError(
        `XBlobRead JSON Parse error at blobAtom ${widString(blobAtom)} on window ${widString(hostWin)} (raw length: ${rawStr.length} bytes, snippet: ${JSON.stringify(snippet)}): ${parseErr.message}`
      );
      err.rawString = rawStr;
      err.blobAtom = blobAtom;
      throw err;
    }
  } else {
    logger.setContext({
      blobAtom: widString(blobAtom),
      hostWin: widString(hostWin)
    });
    throw new Error(
      `XBlobRead: no data found at ${widString(blobAtom)} on window ${widString(hostWin)}`
    );
  }
}

async function parseJsonFrame(X, routerWin, ev, {unlinkPayloadBlob = true}={}) {
  const senderWin = ev.data[0];
  const payloadBlob = ev.data[3] || ev.data[1]; // data.l[3] for XChannelJsonFrame, fallback data.l[1] for XJsonFrame
  logger.setContext({
    sender: widString(senderWin),
    payloadBlob: widString(payloadBlob)
  });
  const payload = await XBlobRead(X, routerWin, payloadBlob);
  if (payload) {
    const cmd = payload.intent || payload.event || payload.action;
    if (cmd) {
      logger.setContext({ command: cmd });
    }
  }
  if(unlinkPayloadBlob){
    XBlobUnlink(X, routerWin, ev.wid, payloadBlob);
  }
  return { targetWin: ev.wid, senderWin, payload, payloadBlob };
}

async function parseXIntentIntentV0(X, routerWin, ev, {unlinkPayloadBlob = true} = {}) {
  const { senderWin, payload, payloadBlob } = await parseJsonFrame(
    X,
    routerWin,
    ev,
    {unlinkPayloadBlob}
  );
  const channel = ev.data[1];
  const controlWord = ev.data[2];
  const dataBlob = ev.data[4];
  return { targetWin: ev.wid, senderWin, channel, controlWord, payload, payloadBlob, dataBlob };
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


const SYN = 1;
const FIN = 2;
const SYN_FIN = 3;

module.exports = {
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
  parseJsonFrame,
  parseXIntentIntentV0,
  parseXIntentEventV0: parseXIntentIntentV0,
  parseXBlobBroadcastFrame,
  parseXBlobDestructorFrame,
  XClientMessage,
  sendXChannelJsonFrame,
  sendXIntentIntentV0,
  sendXIntentEventV0,
  sendXAudioPlayV0,
  sendXAudioControlV0,
  XBlobCreate,
  XBlobGrant,
  XBlobUnlink,
  XBlobSoftLink,
  XBlobSoftUnlink,
  XBlobTransfer,
  XBlobRead,
  XBlobWrite,
  XBlobBroadcast,
};