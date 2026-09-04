// xintent-router.js
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const x11 = require('./x11-promises');

const SERVICE_MAP = {
  'tts.speak': { appName: 'cool-tts', windowClass: 'cool-tts' },
};

async function startRouter() {
  const { X, rawX, root } = await x11.createClientWithPromises();

  // 1. Create Router IPC Window
  const routerWin = X.AllocID();
  await X.CreateWindow(
    routerWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  // 2. Intern Atoms
  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');
  const wmClassAtom = await X.InternAtom(false, 'WM_CLASS');
  const stringAtom = await X.InternAtom(false, 'STRING');
  const wmNameAtom = await X.InternAtom(false, 'WM_NAME');

  // Publish router window reference on Root
  await X.ChangeProperty(0, routerWin, wmNameAtom, stringAtom, 8, 'XINTENT_ROUTER');
  const winBuffer = Buffer.alloc(4);
  winBuffer.writeUInt32LE(routerWin, 0);
  await X.ChangeProperty(0, root, xintentAtom, X.atoms.WINDOW || 33, 32, winBuffer);

  console.log(`[intent-router] Window created: 0x${routerWin.toString(16)}`);

  // 3. Listen for Incoming Intents
  rawX.on('event', async (ev) => {
    if ((ev.type === 33 || ev.name === 'ClientMessage') && ev.wid === routerWin) {
      const prop = await X.GetProperty(0, routerWin, xintentDataAtom, stringAtom, 0, 1000);
      if (prop && prop.data) {
        const payload = JSON.parse(prop.data.toString());
        console.log(`[intent-router] Received Intent Action: "${payload.action}"`);
        await routeIntent(X, root, payload, xintentAtom, xintentDataAtom, wmClassAtom, stringAtom);
      }
    }
    if ((ev.type === 33 || ev.name === 'ClientMessage') && ev.wid === routerWin) {
        const eventAtom = ev.data.readUInt32LE(8);

        if (eventAtom === xintentReplyAtom) {
          // Read the binary blob returned by the service
          const replyProp = await X.GetProperty(0, routerWin, xintentReplyAtom, stringAtom, 0, 100000);
          const blobBuffer = replyProp.data;
          
          console.log(`[intent-router] Received Reply Blob (${blobBuffer.length} bytes):`);
          console.log(blobBuffer.toString('utf-8'));
        }
      }
  });

  console.log('[intent-router] Listening for direct window IPC...');
}

async function routeIntent(X, root, payload, xintentAtom, xintentDataAtom, wmClassAtom, stringAtom) {
  const service = SERVICE_MAP[payload.action];
  if (!service) {
    console.error(`[intent-router] No service mapped for action: ${payload.action}`);
    return;
  }

  let winId = await findWindowByClass(X, root, service.windowClass, wmClassAtom, stringAtom);

  if (winId) {
    console.log(`[intent-router] Found active service window (0x${winId.toString(16)})`);
    await dispatchToWindow(X, winId, payload, xintentAtom, xintentDataAtom, stringAtom);
  } else {
    console.log(`[intent-router] Service inactive. Spawning ${service.appName}...`);
    await execAsync(`bun ${service.appName}-mock.js &`);
    winId = await waitForWindow(X, root, service.windowClass, wmClassAtom, stringAtom);
    if (winId) {
      await dispatchToWindow(X, winId, payload, xintentAtom, xintentDataAtom, stringAtom);
    }
  }
}

async function dispatchToWindow(X, targetWin, payload, xintentAtom, xintentDataAtom, stringAtom) {
  // Store payload directly on target service window
  await X.ChangeProperty(0, targetWin, xintentDataAtom, stringAtom, 8, JSON.stringify(payload));

  // Send ClientMessage trigger to target service window
  const ev = Buffer.alloc(32);
  ev.writeInt8(33, 0);                 // Event Code: ClientMessage
  ev.writeInt8(32, 1);                 // 32-bit format
  ev.writeUInt32LE(targetWin, 4);      // Target Window ID
  ev.writeUInt32LE(xintentAtom, 8);    // Atom

  await X.SendEvent(targetWin, false, x11.eventMask.NoEventMask, ev);
  console.log(`[intent-router] Dispatched payload to 0x${targetWin.toString(16)}`);
}

async function findWindowByClass(X, root, className, wmClassAtom, stringAtom) {
  try {
    const tree = await X.QueryTree(root);
    for (const childWin of tree.children) {
      try {
        const prop = await X.GetProperty(0, childWin, wmClassAtom, stringAtom, 0, 100);
        if (prop && prop.data && prop.data.toString().includes(className)) {
          return childWin;
        }
      } catch (e) {
        continue;
      }
    }
  } catch (e) {
    console.error('[intent-router] QueryTree error:', e);
  }
  return null;
}

async function waitForWindow(X, root, className, wmClassAtom, stringAtom, retries = 20) {
  for (let i = 0; i < retries; i++) {
    const winId = await findWindowByClass(X, root, className, wmClassAtom, stringAtom);
    if (winId) return winId;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`[intent-router] Timeout waiting for window: ${className}`);
  return null;
}

startRouter().catch(console.error);