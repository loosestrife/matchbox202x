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
  const { routerWin, xintentV0Atom } = await xintent.connectToRouter(X, root);

  const lighterWin = X.AllocID();
  await X.CreateWindow(
    lighterWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  const xintentServicesManifestAtom = await X.InternAtom(false, 'XINTENT_SERVICES_MANIFEST');
  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');

  await X.ChangeProperty(0, lighterWin, X.atoms.WM_NAME, X.atoms.STRING, 8, 'MATCHBOX_SERVICE_LIGHTER');
  await X.ChangeProperty(0, lighterWin, xintentServicesManifestAtom, X.atoms.STRING, 8, TOML.stringify(xintentServicesManifesto));
  console.log(`[service-lighter] Registered services (0x${lighterWin.toString(16)})`);

  // 4. Handle Direct Start Signals from xintent-router
  rawX.on('event', async (ev) => {
    if ((ev.type === 33 || ev.name === 'ClientMessage') && ev.wid === lighterWin) {
      const prop = await X.GetProperty(0, lighterWin, xintentDataAtom, X.atoms.STRING, 0, 1000);
      if (!prop || !prop.data) return;

      const payload = JSON.parse(prop.data.toString());
      console.log('[service-lighter] got intent:', payload);

      if(payload.intent != "sys.Launch"){
        console.log("this only responds to sys.Launch");
        return;
      }
      const service = payload.service;
      if (service) {
        console.log(`[service-lighter] Spawning background service process: ${service.exec}`);
        execAsync(`${service.exec} &`).catch(err => {
          console.error(`[service-lighter] Failed to launch service:`, err);
        });
      }
    }
  });

  console.log('[service-lighter] Listening for incoming launch intents...');
}

startLighter().catch(console.error);