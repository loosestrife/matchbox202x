// xintent-router.js
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const x11 = require('./x11-promises');

const SERVICE_MAP = {
  'tts.speak': { appName: 'cool-tts', windowClass: 'cool-tts' },
};

const widString = wid => '0x' + wid.toString(16);

const atoms = {};

async function startRouter() {
  const { X, rawX, root } = await x11.createClientWithPromises();
  const routerWin = X.AllocID();
  await X.CreateWindow(
    routerWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  atoms.XINTENT           = await X.InternAtom(false, 'XINTENT');
  atoms.XINTENT_INTENT_V0 = await X.InternAtom(false, 'XINTENT_INTENT_V0');
  atoms.XINTENT_DATA      = await X.InternAtom(false, 'XINTENT_DATA');
  atoms.XINTENT_BLOB      = await X.InternAtom(false, 'XINTENT_BLOB');
  atoms.WM_CLASS          = await X.InternAtom(false, 'WM_CLASS');
  atoms.STRING            = await X.InternAtom(false, 'STRING');
  atoms.WM_NAME           = await X.InternAtom(false, 'WM_NAME');
  atoms.WINDOW            = await X.InternAtom(false, 'WINDOW');

  /* yeah were not doing SetSelectionOwner
  {
  await X.SetSelectionOwner(routerWin, atoms.XINTENT, 0);
  const owner = await X.GetSelectionOwner(atoms.XINTENT);
  if (owner !== routerWin) {
    throw new Error('XINTENT is already claimed by another process');
  }*/
  {
    let routerAlreadyExists = false;
    let rootRouterWin = null;
    const existingProp = await X.GetProperty(0, root, atoms.XINTENT, atoms.WINDOW, 0, 4);
    if (existingProp && existingProp.data && existingProp.data.length == 4) {
      rootRouterWin = existingProp.data.readUInt32LE(0);
      try {
        await X.GetWindowAttributes(rootRouterWin);
        routerAlreadyExists = true;
      } catch (err) {
        // If GetWindowAttributes throws BadWindow, the previous router crashed/died
        // leaving a stale lock. We can safely proceed to overwrite it.
        console.warn('[intent-router] Found dead router window handle. Reclaiming lock...');
      }
    }
    if(routerAlreadyExists){
      throw new Error(`XINTENT router is already active on window 0x${rootRouterWin.toString(16)}`);
    }
    const winBuffer = Buffer.alloc(4);
    winBuffer.writeUInt32LE(routerWin, 0);
    await X.ChangeProperty(0, root, atoms.XINTENT, atoms.WINDOW, 32, winBuffer);
  }
  await X.ChangeProperty(0, routerWin, atoms.WM_NAME, atoms.STRING, 8, 'XINTENT_ROUTER');
  const winBuffer = Buffer.alloc(4);
  winBuffer.writeUInt32LE(routerWin, 0);
  await X.ChangeProperty(0, root, atoms.XINTENT, atoms.WINDOW, 32, winBuffer);
  console.log(`[intent-router] Window created: ${widString(routerWin)}`);

  rawX.on('event', async (ev) => {
    if (ev.name === 'ClientMessage' && ev.wid === routerWin) {
      console.log("got ClientMessage on routerWin", ev);
      if (ev.message_type === atoms.XINTENT_INTENT_V0) {
        const [senderWin, targetPropAtom, encodingAtom, lengthHint, txId] = ev.data;
        console.log("[router] Received V0 intent trigger", {
          senderWin: widString(senderWin),
          targetPropAtom,
          encodingAtom,
          lengthHint,
          txId
        });
        
        const maxBytes = lengthHint > 0 ? lengthHint : 65536;
        const prop = await X.GetProperty(0, routerWin, targetPropAtom, atoms.STRING, 0, maxBytes);
        
        if (prop && prop.data) {
          const payload = JSON.parse(prop.data.toString());
          console.log("payload data is", payload);
          let blob = null;
          
          if (payload.blob) {
            const { propAtom: blobPropAtom } = payload.blob;
            const blobProp = await X.GetProperty(0, routerWin, blobPropAtom, atoms.STRING, 0, 100000);
            blob = blobProp.data;
            console.log(`received blob of size ${blob ? blob.length : 0}`);
          }
          await routeIntent(X, root, payload, blob);
        }
      }
    }
  });
  console.log('[intent-router] Listening for direct window IPC...');
}

async function routeIntent(X, root, payload, blob) {
  const service = SERVICE_MAP[payload.action];
  if (!service) {
    console.error(`[intent-router] No service mapped for action: ${payload.action}`);
    return;
  }

  let winId = await findWindowByClass(X, root, service.windowClass);

  if (winId) {
    console.log(`[intent-router] Found active service window (${widString(winId)})`);
    await dispatchToWindow(X, winId, payload, blob);
  } else {
    console.log(`[intent-router] Service inactive. Spawning ${service.appName}...`);
    await execAsync(`bun ${service.appName}-mock.js &`);
    winId = await waitForWindow(X, root, service.windowClass);
    if (winId) {
      await dispatchToWindow(X, winId, payload, blob);
    }
  }
}

async function dispatchToWindow(X, targetWin, payload, blob) {
  // Store payload directly on target service window
  await X.ChangeProperty(0, targetWin, atoms.XINTENT_DATA, atoms.STRING, 8, JSON.stringify(payload));

  // Send ClientMessage trigger to target service window
  const ev = Buffer.alloc(32);
  ev.writeInt8(33, 0);                   // Event Code: ClientMessage
  ev.writeInt8(32, 1);                   // 32-bit format
  ev.writeUInt32LE(targetWin, 4);        // Target Window ID
  ev.writeUInt32LE(atoms.XINTENT, 8);    // Atom Message Type

  await X.SendEvent(targetWin, false, x11.eventMask.NoEventMask, ev);
  console.log(`[intent-router] Dispatched payload to ${widString(targetWin)}`);
}

async function findWindowByClass(X, root, className) {
  try {
    const tree = await X.QueryTree(root);
    for (const childWin of tree.children) {
      try {
        const prop = await X.GetProperty(0, childWin, atoms.WM_CLASS, atoms.STRING, 0, 100);
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

async function waitForWindow(X, root, className, retries = 20) {
  for (let i = 0; i < retries; i++) {
    const winId = await findWindowByClass(X, root, className);
    if (winId) return winId;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`[intent-router] Timeout waiting for window: ${className}`);
  return null;
}

startRouter();