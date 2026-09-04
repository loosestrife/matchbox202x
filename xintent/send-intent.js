const x11 = require('./x11-promises');

async function sendIntent() {
  const { X, root } = await x11.createClientWithPromises();

  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');

  // 1. Fetch the Router Window ID stored on the root property
  const prop = await X.GetProperty(0, root, xintentAtom, X.atoms.WINDOW, 0, 4);
  if (!prop || !prop.data || prop.data.length < 4) {
    throw new Error('XINTENT Router window not found! Is xintent-router running?');
  }

  const routerWin = prop.data.readUInt32LE(0);
  console.log(`[sender] Found router window ID: 0x${routerWin.toString(16)}`);

  // 2. Set payload directly on the router's IPC window
  const payload = JSON.stringify({ action: 'tts.speak', text: 'Direct window IPC works!' });
  await X.ChangeProperty(0, routerWin, xintentDataAtom, X.atoms.STRING, 8, payload);

  // 3. Send ClientMessage targeted specifically at routerWin using NoEventMask
  const ev = Buffer.alloc(32);
  ev.writeInt8(33, 0);                 // ClientMessage event code
  ev.writeInt8(32, 1);                 // 32-bit format
  ev.writeUInt32LE(routerWin, 4);      // Target Window ID
  ev.writeUInt32LE(xintentAtom, 8);    // Message Atom

  await X.SendEvent(routerWin, false, X.eventMask.NoEventMask, ev);
  console.log('[sender] Direct ClientMessage dispatched!');
  
  setTimeout(() => process.exit(0), 100);
}

sendIntent().catch(console.error);