const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const x11 = require('./x11-promises');
const xintent = require('./xintent');

const REGISTERED_SERVICES = {
  'tts.speak': { appName: 'cool-tts', windowClass: 'cool-tts', execCmd: 'bun cool-tts-mock.js' }
};

async function startLighter() {
  const { X, rawX, root } = await x11.createClientWithPromises();
  const { routerWin, xintentV0Atom } = await xintent.connectToRouter(X, root);

  const lighterWin = X.AllocID();
  await X.CreateWindow(
    lighterWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  const xintentServicesAtom = await X.InternAtom(false, 'XINTENT_SERVICES');
  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');

  await X.ChangeProperty(0, lighterWin, X.atoms.WM_NAME, X.atoms.STRING, 8, 'MATCHBOX_SERVICE_LIGHTER');

  const serviceManifest = JSON.stringify(
    Object.keys(REGISTERED_SERVICES).map(action => ({
      action,
      windowClass: REGISTERED_SERVICES[action].windowClass,
      lighterWin
    }))
  );

  await X.ChangeProperty(0, root, xintentServicesAtom, X.atoms.STRING, 8, serviceManifest);
  console.log(`[service-lighter] Registered services on root window (0x${lighterWin.toString(16)})`);

  // 4. Handle Direct Start Signals from xintent-router
  rawX.on('event', async (ev) => {
    if ((ev.type === 33 || ev.name === 'ClientMessage') && ev.wid === lighterWin) {
      const prop = await X.GetProperty(0, lighterWin, xintentDataAtom, X.atoms.STRING, 0, 1000);
      if (!prop || !prop.data) return;

      const payload = JSON.parse(prop.data.toString());
      console.log(`[service-lighter] Received start request for action: "${payload.action}"`);

      const service = REGISTERED_SERVICES[payload.action];
      if (service) {
        console.log(`[service-lighter] Spawning background service process: ${service.execCmd}`);
        execAsync(`${service.execCmd} &`).catch(err => {
          console.error(`[service-lighter] Failed to launch service:`, err);
        });
      }
    }
  });

  console.log('[service-lighter] Listening for incoming launch intents...');
}

startLighter().catch(console.error);