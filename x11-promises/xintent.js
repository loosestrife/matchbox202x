// xintent.js
const crypto = require("crypto");
const x11 = require("./x11-promises");

const atoms = {};
const widString = (wid) => "0x" + wid.toString(16);

async function connectToRouter(X, root) {
  const requiredAtoms = ["XINTENT", "XINTENT_INTENT_V0"];
  const requiredResults = await Promise.all(
    requiredAtoms.map(async (atomName) => {
      const atom = await X.InternAtom(true, atomName);
      if (!atom) {
        console.log(`required atom ${atomName} not on server`);
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

    "XINTENT_EVENT_V0",
    "XBLOB_CREATE_V0",
    "XBLOB_CREATE_RESPONSE_V0",
    "XBLOB_GRANT_V0",
    "XBLOB_UNLINK_V0",
    "XBLOB_TRANSFER_V0",
  ];

  await Promise.all(
    protocolAtoms.map(async (atomName) => {
      atoms[atomName] = await X.InternAtom(false, atomName);
    })
  );

  const getRouterWin = async () => {
    const prop = await X.GetProperty(0, root, atoms.XINTENT, atoms.WINDOW, 0, 4);
    if (!prop || !prop.data || prop.data.length < 4) 
      return;
    const candidateRouterWin = prop.data.readUInt32LE(0);
    try {
      await X.GetWindowAttributes(candidateRouterWin);
      const nameProp = await X.GetProperty(
        0,
        candidateRouterWin,
        atoms.WM_NAME,
        atoms.STRING,
        0,
        8
      );
      if (
        !nameProp ||
        !nameProp.data ||
        nameProp.data.toString("utf8") != "XINTENT_ROUTER"
      ) {
        return;
      }
    } catch (err) {
      return;
    }
    module.exports.routerWin = candidateRouterWin;
  }
  X.on('event', async ev => {
    if (ev.name === 'DestroyNotify' && ev.wid == module.exports.routerWin) {
      module.exports.routerWin = undefined;
    }
    if (ev.name === 'PropertyNotify' && ev.wid === root && ev.atom === atoms.XINTENT) {
      await getRouterWin();
    }
  });
  await getRouterWin();
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
  ev.writeUInt32LE(targetWin, 4);
  ev.writeUInt32LE(message_type, 8);
  for (let i = 0; i < data.length && i < 5; i++) {
    ev.writeUInt32LE(data[i], 12 + 4 * i);
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
      ev.type === 33 &&
      ev.message_type === atoms.XBLOB_CREATE_RESPONSE_V0 &&
      ev.data[2] === cookie,
    timeoutMs
  ).SendEvent(routerWin, false, x11.eventMask.NoEventMask, evBuf);

  const blobAtom = responseEv.data[1];
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
      routerWin,
      blobAtom,
      atoms.STRING,
      8,
      chunk
    );
  }
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
  console.log(`x11-promises/xintent:XBlobUnlink(X, ${widString(routerWin)}, ${widString(senderWin)}, ${widString(blobAtom)})`);
  return XClientMessage(X, routerWin, atoms.XBLOB_UNLINK_V0, [
    senderWin,
    blobAtom,
  ]);
}

async function XBlobTransfer(X, routerWin, senderWin, blobAtom, granteeWin) {
  return XClientMessage(X, routerWin, atoms.XBLOB_TRANSFER_V0, [
    senderWin,
    blobAtom,
    granteeWin,
  ]);
}

const sendXIntentIntentV0 = (X, routerWin, messageData) =>
  sendXIV0(atoms.XINTENT_INTENT_V0, X, routerWin, messageData); 
const sendXIntentEventV0 = (X, routerWin, messageData) =>
  sendXIV0(atoms.XINTENT_EVENT_V0, X, routerWin, messageData);

const sendXIV0 = async (
  messageTypeAtom,
  X,
  routerWin,
  { targetWin, senderWin, txId, channel, payload, dataBlob, unlinkPayloadBlob = true}
) => {
  if (!targetWin) {
    targetWin = routerWin;
  }

  // 1. Create payload blob owned by senderWin
  const payloadBlob = await XBlobCreate(X, routerWin, senderWin, payload);

  // 2. Transfer or Grant blob rights BEFORE dispatching intent message
  if (targetWin !== senderWin) {
    if (unlinkPayloadBlob) {
      XBlobTransfer(X, routerWin, senderWin, payloadBlob, targetWin);
    } else {
      XBlobGrant(X, routerWin, senderWin, payloadBlob, targetWin);
    }
  }

  if(txId !== undefined && txId > 16777215){
    console.error("error: txId above 16777216", {txId, channel});
  }
  if(channel !== undefined && (channel != 0 && channel < 16777216)){
    console.error("error: channel under 16777216", {txId, channel});
  }
  if(txId !== undefined && channel !== undefined){
    console.error("error: only allowed to specify one of txId, channel", {txId, channel});
  }

  // 3. Dispatch the intent frame
  XClientMessage(X, targetWin, messageTypeAtom, [
    senderWin,
    payloadBlob,
    txId ?? channel ?? 0,
    dataBlob ?? 0,
  ]);

  console.log(
    `[intent-client] Dispatched ${payload.intent ?? payload.event} to ${widString(targetWin)} (payload blob ${widString(payloadBlob)}${dataBlob ? ` (data blob ${widString(dataBlob)})` : ''})`
  );
  return payloadBlob;
}

async function XBlobRead(X, routerWin, blobAtom) {
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
    return JSON.parse(prop.data.toString());
  } else {
    throw new Error(
      `XBlobRead: no data found at ${widString(blobAtom)} on window ${widString(hostWin)}`
    );
  }
}

async function parseJsonFrame(X, routerWin, ev, {unlinkPayloadBlob = true}={}) {
  const [senderWin, payloadBlob] = ev.data;
  const payload = await XBlobRead(X, routerWin, payloadBlob);
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
  const channel = ev.data[2];
  const dataBlob = ev.data[3];
  return { targetWin: ev.wid, senderWin, channel, payload, payloadBlob, dataBlob };
}


module.exports = {
  connectToRouter,
  createClientWindow,
  atoms,
  widString,
  parseJsonFrame,
  parseXIntentIntentV0,
  parseXIntentEventV0: parseXIntentIntentV0,
  XClientMessage,
  sendXIntentIntentV0,
  sendXIntentEventV0,
  XBlobCreate,
  XBlobGrant,
  XBlobUnlink,
  XBlobTransfer,
  XBlobRead,
};