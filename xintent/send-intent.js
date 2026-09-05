const x11 = require('./util/x11-promises');
const xintent = require('./util/xintent');

const atoms = {}
async function sendIntent() {
  const { X, root } = await x11.createClientWithPromises();

  atoms.XINTENT = await X.InternAtom(false, 'XINTENT');
  atoms.XINTENT_DATA = await X.InternAtom(false, 'XINTENT_DATA');
  const { routerWin, xintentV0Atom } = await xintent.connectToRouter(X, root);
  atoms.XINTENT_INTENT_V0 = xintentV0Atom;
  console.log(`[sender] Found router window ID: 0x${routerWin.toString(16)}`);

  const payload = JSON.stringify({ intent: 'ui.TextToSpeech', text: 'Direct window IPC works!' });
  await X.ChangeProperty(0, routerWin, atoms.XINTENT_DATA, X.atoms.STRING, 8, payload);
  const ev = Buffer.alloc(32);
  ev.writeInt8(33, 0);                 // ClientMessage event code
  ev.writeInt8(32, 1);                 // 32-bit format
  ev.writeUInt32LE(routerWin, 4);      // Target Window ID
  ev.writeUInt32LE(atoms.XINTENT_INTENT_V0, 8);    // Message Atom

  ev.writeUInt32LE(0, 12); // no sender window
  ev.writeUInt32LE(atoms.XINTENT_DATA, 16); // target property atom
  ev.writeUInt32LE(67, 20); // txId;

  await X.SendEvent(routerWin, false, X.eventMask.NoEventMask, ev);
  console.log('[sender] Direct ClientMessage dispatched!');  
  setTimeout(() => process.exit(0), 100);
}

sendIntent().catch(console.error);