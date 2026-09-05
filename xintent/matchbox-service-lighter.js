// matchbox-service-lighter.js
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const TOML = require('@iarna/toml');
const {intentRegistry, packageRegistry, buildRegistries, xintentServicesManifesto} = require('./util/intent-registry');
const x11 = require('./util/x11-promises');
const xintent = require('./util/xintent');


console.log(TOML.stringify(xintentServicesManifesto));

async function startLighter() {
  const { X, rawX, root } = await x11.createClientWithPromises();

  const lighterWin = X.AllocID();
  await X.CreateWindow(
    lighterWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  const xintentServicesManifestAtom = await X.InternAtom(false, 'XINTENT_SERVICES_MANIFEST');
  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentIntentV0Atom = await X.InternAtom(false, 'XINTENT_INTENT_V0');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');

  await X.ChangeProperty(0, lighterWin, X.atoms.WM_NAME, X.atoms.STRING, 8, 'MATCHBOX_SERVICE_LIGHTER');
  await X.ChangeProperty(0, lighterWin, xintentServicesManifestAtom, X.atoms.STRING, 8, TOML.stringify(xintentServicesManifesto));
  console.log(`[service-lighter] Registered services (0x${lighterWin.toString(16)})`);

  // 4. Handle Direct Start Signals from xintent-router
  rawX.on('event', async (ev) => {
    if ((ev.type === 33 || ev.name === 'ClientMessage') && ev.wid === lighterWin) {
      if (ev.message_type != xintentIntentV0Atom) {
        console.error(`got unknown message type atom ${ev.message_type}`);
        return;
      }
      const [senderWin, targetPropAtom, txId] = ev.data;
      const prop = await X.GetProperty(0, lighterWin, targetPropAtom, X.atoms.STRING, 0, 1000);
      if (!prop || !prop.data || prop.data.length == 0){
        console.error(`nothing found on targetPropAtom ${targetPropAtom}`)
        return;
      };

      const payload = JSON.parse(prop.data.toString());
      console.log('[service-lighter] got intent:', payload);

      if(payload.intent != "sys.Launch"){
        console.log("this only responds to sys.Launch");
        return;
      }
      const pakName = payload.package;
      const package = packageRegistry[pakName];
      const intent = package.intents[payload.intendedIntent];
      console.log(`[service-lighter] Got request to load ${pakName} for ${payload.intendedIntent}`, intent);
      execAsync(`${intent.exec} &`).catch(err => {
        console.error(`[service-lighter] Failed to launch service:`, err);   
      });
      // no need to inform intent-registry.  intent-registry waits for the new service to declae its matchbox.toml
    }
  });

  console.log('[service-lighter] Listening for incoming launch intents...');
}

startLighter().catch(console.error);