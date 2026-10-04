// matchbox-service-lighter/index.js
const { spawn } = require('child_process');
const util = require('util');
const TOML = require('@iarna/toml');
const {intentRegistry, packageRegistry, buildRegistries, xintentServicesManifesto} = require('./intent-registry');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');
const {Logger} = require('../server-tools');
const pickFiles = require('./pick-files');

const logger = new Logger({module: 'index.js'});
logger.setProjectName('service-lighter')

logger.info('got manifesto', TOML.stringify(xintentServicesManifesto));

const hostname = os.hostname();
const matchboxToml = `
[intents]
"sys.Launch" = true
"fs.PickFile" = true
"fs.PickFilePath" = true

[XBlobHost]
host = "${hostname}"
`;

async function startLighter() {
  const { X, rawX, root } = await x11.createClientWithPromises();
  await xintent.connectToRouter(X, root);

  const lighterWin = X.AllocID();
  X.CreateWindow(
    lighterWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  pickFiles.init({X, lighterWin});

  const xintentServicesManifestAtom = await X.InternAtom(false, 'XINTENT_SERVICES_MANIFEST');
  const xintentMatchboxTomlAtom = await X.InternAtom(false, 'XINTENT_MATCHBOX_TOML');

  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentIntentV0Atom = await X.InternAtom(false, 'XINTENT_INTENT_V0');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');

  const xblobDestructorAtom = await X.InternAtom(false, 'XBLOB_DESTRUCTOR_V0');
  const xblobBroadcastAtom = await X.InternAtom(false, 'XBLOB_BROADCAST_V0');

  X.ChangeProperty(0, lighterWin, X.atoms.WM_NAME, X.atoms.STRING, 8, 'MATCHBOX_SERVICE_LIGHTER');
  X.ChangeProperty(0, lighterWin, xintentServicesManifestAtom, X.atoms.STRING, 8, TOML.stringify(xintentServicesManifesto));
  X.ChangeProperty(0, lighterWin, xintentMatchboxTomlAtom, X.atoms.STRING, 8, matchboxToml);

  const pidBuf = Buffer.alloc(4);
  pidBuf.writeUInt32LE(process.pid, 0);
  X.ChangeProperty(0, lighterWin, xintent.atoms._NET_WM_PID, xintent.atoms.CARDINAL, 32, pidBuf);
  logger.info(`Registered services (0x${lighterWin.toString(16)})`);

  // 4. Handle Direct Start Signals from xintent-router
  rawX.on('event', async (ev) => {
    if ((ev.type === 33 || ev.name === 'ClientMessage') && ev.wid === lighterWin) {
      if (ev.message_type == xintentIntentV0Atom) {
        const xintentIntent = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
        const payload = xintentIntent.payload;
        if(payload.intent == "sys.Launch"){
          const pakName = payload.package;
          const package = packageRegistry[pakName];
          const intent = package.intents[payload.intendedIntent];
          logger.info(`Got request to load ${pakName} for ${payload.intendedIntent}`, intent);

          spawn(intent.exec, {shell: true, stdio: 'inherit'}).on('error', err => {
            logger.error(`Failed to launch service:`, err);   
          });
          // no need to inform intent-registry.  intent-registry waits for the new service to declae its matchbox.toml
        }
        else if(payload.intent == "fs.PickFilePath"){
          pickFiles.pickFilePath(xintentIntent);
        }
        else if(payload.intent == "fs.PickFile"){
          pickFiles.pickFile(xintentIntent);
        }
        else {
          logger.warn("unknown intent", payload.intent);
          return;
        }
      }
      else if (ev.message_type == xblobBroadcastAtom) {
        const frame = xintent.parseXBlobBroadcastFrame(X, xintent.routerWin, ev);
        pickFiles.xblobBroadcast(frame);
      }
      else if (ev.message_type == xblobDestructorAtom) {
        const frame = xintent.parseXBlobDestructorFrame(X, xintent.routerWin, ev);
        pickFiles.xblobDestructor(frame);
      }
      else {
        logger.error(`got unknown message type atom ${ev.message_type}`);
        return;
      }
    }
  });

  logger.info('Listening for incoming launch intents...');
}

startLighter().catch(console.error);