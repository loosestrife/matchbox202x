// xintent-router.js
const { exec } = require('child_process');
const TOML = require('@iarna/toml');
const util = require('util');
const execAsync = util.promisify(exec);
const x11 = require('./util/x11-promises');

const widString = wid => '0x' + wid.toString(16);

const atoms = {};
let routerWin;

async function startRouter() {
  const { X, rawX, root } = await x11.createClientWithPromises();
  routerWin = X.AllocID();
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
  atoms.XINTENT_MATCHBOX_TOML = await X.InternAtom(false, 'XINTENT_MATCHBOX_TOML');
  atoms.XINTENT_SERVICES_MANIFEST = await X.InternAtom(false, 'XINTENT_SERVICES_MANIFEST');

  /* could do this but it would mean a new xintent-router would take over immediately
  await X.SetSelectionOwner(routerWin, atoms.XINTENT, 0);
  * meanwhile the icccm preferred race-free window manager replacement mechanism is a lot of code for a proof of concept project
  */
  {
    let routerAlreadyExists = false;
    let rootRouterWin = null;
    const existingProp = await X.GetProperty(0, root, atoms.XINTENT, atoms.WINDOW, 0, 4);
    if (existingProp && existingProp.data && existingProp.data.length == 4) {
      rootRouterWin = existingProp.data.readUInt32LE(0);
      try {
        const nameProp = await X.GetProperty(0, rootRouterWin, atoms.WM_NAME, atoms.STRING, 0, 8);
        if (nameProp && nameProp.data) {
          const windowName = nameProp.data.toString('utf8');
          if (windowName === 'XINTENT_ROUTER') {
            routerAlreadyExists = true;
          }
        }
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
  console.log('atoms are', atoms);
  await X.ChangeWindowAttributes(root, { eventMask: x11.eventMask.SubstructureNotify });
  await getAllMatchboxToml(X, root);
  console.log(`[intent-router] Window created: ${widString(routerWin)}`);

  rawX.on('event', async (ev) => {
    // Handle Window Creation -> Watch for Property Changes
    if (ev.name === 'CreateNotify') {
      await X.ChangeWindowAttributes(ev.wid, { eventMask: x11.eventMask.PropertyChange });
    }

    // Handle TOML updates on windows
    if (ev.name === 'PropertyNotify' && ev.atom === atoms.XINTENT_MATCHBOX_TOML) {
      await parseWindowToml(X, ev.wid);
    }

    if (ev.name === 'ClientMessage' && ev.wid === routerWin) {
      console.log("got ClientMessage on routerWin", ev);
      if (ev.message_type == atoms.XINTENT_INTENT_V0) {
        const [senderWin, targetPropAtom, txId] = ev.data;
        const evData = {senderWin, txId};
        console.log("[router] Received V0 intent trigger", {
          senderWin: widString(senderWin),
          targetPropAtom,
          txId,
        });
        
        const prop = await X.GetProperty(0, routerWin, targetPropAtom, atoms.STRING, 0, 1000000);
        
        if (prop && prop.data) {
          X.DeleteProperty(routerWin, targetPropAtom);
          const payload = JSON.parse(prop.data.toString());
          console.log("payload data is", payload);
          let blob = null;
          
          if (payload.blob) {
            const { propAtom: blobPropAtom } = payload.blob;
            const blobProp = await X.GetProperty(0, routerWin, blobPropAtom, atoms.STRING, 0, 100000);
            blob = blobProp.data;
            console.log(`received blob of size ${blob ? blob.length : 0}`);
          }
          await routeIntent(X, root, payload, evData, blob);
        }
      }
    }
  });
  console.log('[intent-router] Listening for direct window IPC...');
}

async function routeIntent(X, root, payload, evData, blob) {
  const intent = payload.intent;
  const registryEntry = intentRegistry[intent];
  if (!registryEntry) {
    console.info(`[intent-router] No service mapped for action: ${intent}, falling back to lighter ${JSON.stringify(lighterRegistry, null, 2)}`);
    const lighterRegistryEntry = lighterRegistry[intent];
    if(lighterRegistryEntry && lighterRegistryEntry.length > 0){
      const {computer, packageName, wid, publicKeyHash} = lighterRegistryEntry[0];
      await dispatchToWindow(X, wid, {
        intent: 'sys.Launch',
        computer,
        package: packageName,
        intendedIntent: intent,
      }, {senderWin: routerWin, txId: 0});
    }
    return;
  }
  const {wid, matchboxToml} = registryEntry[0];
  if (wid) {
    console.log(`[intent-router] Found active service window (${widString(wid)})`);
    await dispatchToWindow(X, wid, payload, {senderWin: evData.senderWin, txId: evData.txId}, blob);
  } else {
    console.log(`[intent-router] Service inactive. Trying to launch...`);
    // matchbox-service-lighter call here
    newWid = await waitForWindow(X, root, service.windowClass);
    if (newW) {
      await dispatchToWindow(X, newWid, payload, {senderWin: evData.senderWin, txId: evData.txId}, blob);
    }
  }
}

async function dispatchToWindow(X, targetWin, payload, evData, blob) {
  await X.ChangeProperty(0, targetWin, atoms.XINTENT_DATA, atoms.STRING, 8, JSON.stringify(payload));
  const ev = Buffer.alloc(32);
  ev.writeInt8(33, 0);                   // Event Code: ClientMessage
  ev.writeInt8(32, 1);                   // 32-bit format
  ev.writeUInt32LE(targetWin, 4);        // Target Window ID
  ev.writeUInt32LE(atoms.XINTENT_INTENT_V0, 8);    // Atom Message Type
  ev.writeUInt32LE(evData.senderWin, 12);
  ev.writeUInt32LE(evData.targetPropAtom ?? atoms.XINTENT_DATA, 16);
  ev.writeUInt32LE(evData.txId ?? 0, 20);
  await X.SendEvent(targetWin, false, x11.eventMask.NoEventMask, ev);
  console.log(`[intent-router] Dispatched payload to ${widString(targetWin)}`);
}


const intentRegistry = {};
async function getAllMatchboxToml(X, root) {
  const tree = await X.QueryTree(root);
  for (const wid of tree.children) {
    await parseWindowToml(X, wid);
    await parseWindowLighterToml(X, wid);
  }
}

async function parseWindowToml(X, wid) {
  try {
    const prop = await X.GetProperty(0, wid, atoms.XINTENT_MATCHBOX_TOML, 0, 0, 1000000);
    if (prop && prop.data && prop.data.length > 0) {
      const matchboxToml = TOML.parse(prop.data.toString('utf8'));
      if (matchboxToml.intents) {
        for (const intentName of Object.keys(matchboxToml.intents)) {
          if (!intentRegistry[intentName]) intentRegistry[intentName] = [];
          
          // Avoid duplicate bindings for the same window
          if (!intentRegistry[intentName].some(entry => entry.wid === wid)) {
            intentRegistry[intentName].push({ wid, matchboxToml });
            console.log(`[router] Registered intent '${intentName}' -> Window ${widString(wid)}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[router] Failed parsing TOML on window ${widString(wid)}:`, err.message);
  }
}

const lighterRegistry = {};
async function parseWindowLighterToml(X, wid) {
  const prop = await X.GetProperty(0, wid, atoms.XINTENT_SERVICES_MANIFEST, atoms.STRING, 0, 1000000);
  if (prop && prop.data && prop.data.length > 0) {
    const toml = TOML.parse(prop.data.toString('utf8'));
    console.log('got XINTENT_SERVICES_MANIFEST from window', widString(wid), toml);
    const computer = toml.computer;
    for (const packageName of Object.keys(toml.packages)) {
      const publicKeyHash = toml.packages[packageName].publicKeyHash;
      for(const intentName of Object.keys(toml.packages[packageName].intents)){
        if (!lighterRegistry[intentName])
          lighterRegistry[intentName] = [];
        lighterRegistry[intentName].push({ wid, computer, packageName, publicKeyHash });
      }
    }
  }
}
  



startRouter();