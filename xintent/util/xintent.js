// xintent.js
const crypto = require('crypto');
const x11 = require('./x11-promises');

const atoms = {};
const widString = wid => '0x' + wid.toString(16);

async function connectToRouter(X, root) {
  const xintentAtom = await X.InternAtom(true, 'XINTENT');
  if (!xintentAtom) return 0;

  atoms.STRING = await X.InternAtom(false, 'STRING');
  atoms.WINDOW = await X.InternAtom(false, 'WINDOW');
  atoms.WM_NAME = await X.InternAtom(false, 'WM_NAME');
  atoms.XINTENT = xintentAtom;

  const prop = await X.GetProperty(0, root, atoms.XINTENT, atoms.WINDOW, 0, 4);
  if (!prop || !prop.data || prop.data.length < 4) return 0;
  
  const routerWin = prop.data.readUInt32LE(0);

  try {
    await X.GetWindowAttributes(routerWin);
    const nameProp = await X.GetProperty(0, routerWin, atoms.WM_NAME, atoms.STRING, 0, 8);
    if (!nameProp || !nameProp.data || !(nameProp.data.toString('utf8') === 'XINTENT_ROUTER')) {
      return 0;
    }
  } catch (err) {
    return 0;
  }

  const xintentV0Atom = await X.InternAtom(true, 'XINTENT_INTENT_V0');
  if (!xintentV0Atom) return 0;

  atoms.XINTENT_INTENT_V0 = xintentV0Atom;
  atoms.XBLOB_CREATE_V0 = await X.InternAtom(false, 'XBLOB_CREATE_V0');
  atoms.XBLOB_CREATE_RESPONSE_V0 = await X.InternAtom(false, 'XBLOB_CREATE_RESPONSE_V0');
  atoms.XBLOB_GRANT_V0 = await X.InternAtom(false, 'XBLOB_GRANT_V0');
  atoms.XBLOB_UNLINK_V0 = await X.InternAtom(false, 'XBLOB_UNLINK_V0');

  return routerWin;
}

function buildClientMessageBuffer(targetWin, message_type, data) {
  const ev = Buffer.alloc(32);
  ev.writeInt8(33, 0); // ClientMessage
  ev.writeInt8(32, 1); // 32 bit format
  ev.writeUInt32LE(targetWin, 4);
  ev.writeUInt32LE(message_type, 8);
  for (let i = 0; (i < data.length) && (i < 5); i++) {
    ev.writeUInt32LE(data[i], 12 + 4 * i);
  }
  return ev;
}

function XClientMessage(X, targetWin, message_type, data) {
  const ev = buildClientMessageBuffer(targetWin, message_type, data);
  return X.SendEvent(targetWin, false, x11.eventMask.NoEventMask, ev);
}

async function XBlobCreate(X, routerWin, senderWin, blobData, timeoutMs = 5000) {
  const cookie = crypto.randomBytes(4).readUInt32LE(0);
  const evBuf = buildClientMessageBuffer(routerWin, atoms.XBLOB_CREATE_V0, [senderWin, cookie]);
  const responseEv = await X.seekResponsePacket(
    ev => ev.type == 33 && 
      ev.message_type == atoms.XBLOB_CREATE_RESPONSE_V0 && 
      ev.data[2] == cookie,
    timeoutMs
  ).SendEvent(routerWin, false, x11.eventMask.NoEventMask, evBuf);

  const blobAtom = responseEv.data[1];
  const payloadBuf = Buffer.from(JSON.stringify(blobData, null, 2));
  X.ChangeProperty(0, routerWin, blobAtom, atoms.STRING, 8, payloadBuf);
  return blobAtom;
}

async function XBlobGrant(X, routerWin, senderWin, blobAtom, granteeWin) {
  XClientMessage(X, routerWin, atoms.XBLOB_GRANT_V0, [senderWin, blobAtom, granteeWin]);
}

async function XBlobUnlink(X, routerWin, senderWin, blobAtom) {
  XClientMessage(X, routerWin, atoms.XBLOB_UNLINK_V0, [senderWin, blobAtom]);
}

async function sendXIntentIntentV0(X, routerWin, { targetWin, senderWin, txId, payload, unlinkPayloadBlob = true }) {
  if (!targetWin) {
    targetWin = routerWin;
  }
  const payloadAtom = await XBlobCreate(X, routerWin, senderWin, payload);
  XClientMessage(X, targetWin, atoms.XINTENT_INTENT_V0, [senderWin, payloadAtom, txId ?? 0]);
  if (unlinkPayloadBlob) {
    XBlobUnlink(X, routerWin, senderWin, payloadAtom);
  }
  console.log(`[intent-router] Dispatched ${payload.intent || 'intent'} to ${widString(targetWin)} (payload blob ${widString(payloadAtom)})`);
  return payloadAtom;
}

async function XBlobRead(X, routerWin, blobAtom) {
  const prop = await X.GetProperty(0, routerWin, blobAtom, atoms.STRING, 0, 100000000);
  if (prop && prop.data) {
    return JSON.parse(prop.data.toString());
  } else {
    throw new Error(`XBlobRead: no data found at ${widString(blobAtom)} on window ${widString(routerWin)}`);
  }
}

async function parseJsonFrame(X, routerWin, ev) {
  const [senderWin, payloadAtom] = ev.data;
  const payload = await XBlobRead(X, routerWin, payloadAtom);
  return { targetWin: ev.wid, senderWin, payload, payloadAtom };
}

async function parseXIntentIntentV0(X, routerWin, ev) {
  const { senderWin, payload, payloadAtom } = await parseJsonFrame(X, routerWin, ev);
  const txId = ev.data[2];
  return { targetWin: ev.wid, senderWin, txId, payload, payloadAtom };
}

module.exports = {
  connectToRouter,
  atoms,
  widString,
  parseJsonFrame,
  parseXIntentIntentV0,
  XClientMessage,
  sendXIntentIntentV0,
  XBlobCreate,
  XBlobGrant,
  XBlobUnlink,
  XBlobRead,
};