// xintent.js
const x11 = require('./x11-promises');

async function connectToRouter(X, root) {
  // 1. Check if router is active
  const xintentAtom = await X.InternAtom(true, 'XINTENT');
  if (!xintentAtom)
    return 0;
  atoms.STRING = await X.InternAtom(false, 'STRING');
  atoms.WINDOW = await X.InternAtom(false, 'WINDOW');
  atoms.WM_NAME = await X.InternAtom(false, 'WM_NAME');
  atoms.XINTENT = xintentAtom;
  const prop = await X.GetProperty(0, root, atoms.XINTENT, atoms.WINDOW, 0, 4);
  if (!prop || !prop.data || prop.data.length < 4) {
    return 0;
  }
  const routerWin = prop.data.readUInt32LE(0);

  try {
    // Attempting to query geometry or attributes on a destroyed window throws a BadWindow error
    await X.GetWindowAttributes(routerWin);
    
    // Check if the WM_NAME is still intact
    const nameProp = await X.GetProperty(0, routerWin, atoms.WM_NAME, atoms.STRING, 0, 8);
    if(!nameProp || !nameProp.data || !(nameProp.data.toString('utf8') === 'XINTENT_ROUTER')){
      return 0;
    };
  } catch (err) {
    return 0;
  }

  // 2. Negotiate protocol version
  const xintentV0Atom = await X.InternAtom(true, 'XINTENT_INTENT_V0');
  if (!xintentV0Atom) {
    return 0;
  }
  atoms.XINTENT_INTENT_V0 = xintentV0Atom;
  atoms.XINTENT_DATA = await X.InternAtom(false, 'XINTENT_DATA');
  return routerWin;
}

const atoms = {};

const widString = wid => '0x' + wid.toString(16);

async function sendXintentIntentV0(X, {targetWin, senderWin, txId, targetPropAtom, payload, blob}) {
  X.ChangeProperty(0, targetWin, atoms.XINTENT_DATA, atoms.STRING, 8, JSON.stringify(payload));
  const ev = Buffer.alloc(32);
  ev.writeInt8(33, 0);                   // Event Code: ClientMessage
  ev.writeInt8(32, 1);                   // 32-bit format
  ev.writeUInt32LE(targetWin, 4);        // Target Window ID
  ev.writeUInt32LE(atoms.XINTENT_INTENT_V0, 8);    // Atom Message Type
  ev.writeUInt32LE(senderWin, 12);
  ev.writeUInt32LE(targetPropAtom ?? atoms.XINTENT_DATA, 16);
  ev.writeUInt32LE(txId ?? 0, 20);
  X.SendEvent(targetWin, false, x11.eventMask.NoEventMask, ev);
  console.log(`[intent-router] Dispatched ${payload.intent} to ${widString(targetWin)}`);
}

async function parseXintentIntentV0(X, ev){
  if (ev.message_type != atoms.XINTENT_INTENT_V0)
    return null;
  const targetWin = ev.wid;
  const [senderWin, targetPropAtom, txId] = ev.data;
  const evData = {senderWin, txId};
  console.log("[router] Received XINTENT_INTENT_V0", {
    senderWin: widString(senderWin) || '0x0',
    targetPropAtom,
    txId,
  });
  const prop = await X.GetProperty(0, targetWin, targetPropAtom, atoms.STRING, 0, 1000000);
  let payload, blob;
  if (prop && prop.data) {
    X.DeleteProperty(0, targetWin, targetPropAtom);
    const payload = JSON.parse(prop.data.toString());
    console.log("payload data is", payload);
    if (payload.blob) {
      const { propAtom: blobPropAtom } = payload.blob;
      const blobProp = await X.GetProperty(0, targetWin, blobPropAtom, atoms.STRING, 0, 100000);
      X.DeleteProperty(0, targetWin, blobPropAtom);
      blob = blobProp.data;
      console.log(`received blob of size ${blob ? blob.length : 0}`);
    }
  }
  return {targetWin, senderWin, txId, targetPropAtom, payload, blob};
}

module.exports = {connectToRouter, atoms, sendXintentIntentV0, parseXintentIntentV0, widString};