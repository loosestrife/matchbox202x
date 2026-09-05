// xintent-router.js
const { exec } = require('child_process');
const TOML = require('@iarna/toml');
const util = require('util');
const execAsync = util.promisify(exec);
const x11 = require('./util/x11-promises');
const { connectToRouter, parseXintentIntentV0, sendXintentIntentV0, widString, atoms } = require('./util/xintent');

let routerWin;

async function startRouter() {
  const { X, rawX, root } = await x11.createClientWithPromises();
  routerWin = await connectToRouter(X, root);
  if(routerWin){
    console.log('intent router already running', widString(routerWin));
    process.exit(0);
    return;
  }
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
  /*{
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
  }*/
  const winBuffer = Buffer.alloc(4);
  winBuffer.writeUInt32LE(routerWin, 0);
  await X.ChangeProperty(0, root, atoms.XINTENT, atoms.WINDOW, 32, winBuffer);
  await X.ChangeProperty(0, routerWin, atoms.WM_NAME, atoms.STRING, 8, 'XINTENT_ROUTER');
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
      const xintentIntent = parseXintentIntentV0(X, ev);
      if(xintentIntent){
        await routeIntent(X, root, xintentIntent);
      }
    }
  });
  console.log('[intent-router] Listening for direct window IPC...');
}

const intentsAwaitingServicesQueue = {};
async function routeIntent(X, root, xintentIntent) {
  const intent = xintentIntent.payload.intent;
  const registryEntry = intentRegistry[intent];
  if (!registryEntry) {
    console.info(`[intent-router] No service mapped for action: ${intent}, falling back to lighter ${JSON.stringify(lighterRegistry, null, 2)}`);
    const lighterRegistryEntry = lighterRegistry[intent];
    if(lighterRegistryEntry && lighterRegistryEntry.length > 0){
      const {computer, packageName, wid, publicKeyHash} = lighterRegistryEntry[0];
      await sendXintentIntentV0(X, {
        targetWin: wid,
        senderWin: routerWin,
        txId: 0,
        payload: {
          intent: 'sys.Launch',
          computer,
          package: packageName,
          intendedIntent: intent,
        }
      });
      if(!intentsAwaitingServicesQueue[intent]){
        intentsAwaitingServicesQueue[intent] = [];
      }
      intentsAwaitingServicesQueue[intent].push(xintentIntent);
      return;
    }
    console.error(`no launchable service found for ${intent}`);
  }
  const {wid, matchboxToml} = registryEntry[0];
  console.log(`[intent-router] Found service window (${widString(wid)})`);
  await sendXintentIntentV0(X, {
    targetWin: wid,
    senderWin: xintentIntent.senderWin,
    txId: xintentIntent.txId,
    payload,
    blob
  });
}

async function checkToDrainIntentsQueue(X, root, intent){
  const queue = intentsAwaitingServicesQueue[intent];
  while(queue && queue.length){
    routeIntent(X, root, queue.pop());
  }
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
            checkToDrainIntentsQueue(X, root, intentName);
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