// matchbox-service-lighter/index.js
const { spawn } = require('child_process');
const util = require('util');
const TOML = require('@iarna/toml');
const {intentRegistry, packageRegistry, buildRegistries, xintentServicesManifesto} = require('./intent-registry');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');


console.log(TOML.stringify(xintentServicesManifesto));

async function startLighter() {
  const { X, rawX, root } = await x11.createClientWithPromises();
  const routerWin = await xintent.connectToRouter(X, root);

  const lighterWin = X.AllocID();
  X.CreateWindow(
    lighterWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  const xintentServicesManifestAtom = await X.InternAtom(false, 'XINTENT_SERVICES_MANIFEST');
  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentIntentV0Atom = await X.InternAtom(false, 'XINTENT_INTENT_V0');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');

  X.ChangeProperty(0, lighterWin, X.atoms.WM_NAME, X.atoms.STRING, 8, 'MATCHBOX_SERVICE_LIGHTER');
  X.ChangeProperty(0, lighterWin, xintentServicesManifestAtom, X.atoms.STRING, 8, TOML.stringify(xintentServicesManifesto));
  const pidBuf = Buffer.alloc(4);
  pidBuf.writeUInt32LE(process.pid, 0);
  X.ChangeProperty(0, lighterWin, xintent.atoms._NET_WM_PID, xintent.atoms.CARDINAL, 32, pidBuf);
  console.log(`[service-lighter] Registered services (0x${lighterWin.toString(16)})`);

  // 4. Handle Direct Start Signals from xintent-router
  rawX.on('event', async (ev) => {
    if ((ev.type === 33 || ev.name === 'ClientMessage') && ev.wid === lighterWin) {
      if (ev.message_type != xintentIntentV0Atom) {
        console.error(`got unknown message type atom ${ev.message_type}`);
        return;
      }
      const xintentIntent = await xintent.parseXIntentIntentV0(X, routerWin, ev);
      const payload = xintentIntent.payload;
      if(payload.intent != "sys.Launch"){
        console.log("this only responds to sys.Launch");
        return;
      }
      const pakName = payload.package;
      const package = packageRegistry[pakName];
      const intent = package.intents[payload.intendedIntent];
      console.log(`[service-lighter] Got request to load ${pakName} for ${payload.intendedIntent}`, intent);

      spawn(intent.exec, {shell: true, stdio: 'inherit'}).on('error', err => {
        console.error(`[service-lighter] Failed to launch service:`, err);   
      });
      // no need to inform intent-registry.  intent-registry waits for the new service to declae its matchbox.toml
    }
  });

  console.log('[service-lighter] Listening for incoming launch intents...');
}

startLighter().catch(console.error);