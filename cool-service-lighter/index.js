// cool-service-lighter/index.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const TOML = require('@iarna/toml');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');
const { Logger } = require('../server-tools');
const pickFiles = require('./xblob-host');
const xaudioNode = require('./xaudio-node');
const { trackChild, setupSignalHandlers } = require('./process-supervisor');
const { ensureXIntentRouter, ensureHttpBridge, ensureXdgPortalBridge } = require('./daemon-launcher');
const { handleClientMessageEvent } = require('./intent-dispatcher');

const logger = new Logger({ module: 'index.js' });
xintent.init({ logger: new Logger({ module: 'libxintent' }) });
logger.setProjectName('cool-service-lighter');

const { packageRegistry, xintentServicesManifesto } = require('./intent-registry');
logger.info('got manifesto', TOML.stringify(xintentServicesManifesto));

setupSignalHandlers();

const hostname = os.hostname();
const sinkName = `${hostname}-speakers`;

const matchboxToml = `
[app]
id = "cool-service-lighter"

[intents]
"sys.Launch" = true
"fs.PickFile" = true
"fs.PickFilePath" = true

[XAudioSink]
name = "${sinkName}"
`;

const blobhostMatchboxToml = `
[XBlobHost]
host = "${hostname}"
`;

async function startLighter() {
  const { X, rawX, root } = await x11.createClientWithPromises();

  const lighterWin = X.AllocID();
  X.CreateWindow(
    lighterWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  const blobHostWin = X.AllocID();
  X.CreateWindow(
    blobHostWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  pickFiles.init({ X, lighterWin, blobHostWin, trackChild });
  xaudioNode.init({ X, lighterWin, sinkName, trackChild });

  const serviceManifestTomlAtom = await X.InternAtom(false, 'SERVICE_MANIFEST_TOML');
  const matchboxTomlAtom = await X.InternAtom(false, 'MATCHBOX_TOML');
  const netWmPidAtom = await X.InternAtom(false, '_NET_WM_PID');

  const atoms = {
    xintentIntentV0Atom: await X.InternAtom(false, 'XINTENT_INTENT_V0'),
    xintentEventV0Atom: await X.InternAtom(false, 'XINTENT_EVENT_V0'),
    xaudioPlaySoundBlobAtom: await X.InternAtom(false, 'XAUDIO_PLAY_V0'),
    xaudioPrefetchSoundBlobAtom: await X.InternAtom(false, 'XAUDIO_PREFETCH_SOUND_BLOB_V0'),
    xaudioPlayStreamAtom: await X.InternAtom(false, 'XAUDIO_PLAY_STREAM_V0'),
    xaudioControlStreamAtom: await X.InternAtom(false, 'XAUDIO_CONTROL_V0'),
    xaudioSeekStreamAtom: await X.InternAtom(false, 'XAUDIO_SEEK_STREAM_V0'),
    xblobBroadcastAtom: await X.InternAtom(false, 'XBLOB_BROADCAST_V0'),
    xblobDestructorAtom: await X.InternAtom(false, 'XBLOB_DESTRUCTOR_V0'),
    xblobCreateResponseAtom: await X.InternAtom(false, 'XBLOB_CREATE_RESPONSE_V0'),
    xintentDataAtom: await X.InternAtom(false, 'XINTENT_DATA'),
  };

  const sessionSpeakersAtom = await X.InternAtom(false, 'SESSION_SPEAKERS');

  X.ChangeProperty(0, lighterWin, X.atoms.WM_NAME, X.atoms.STRING, 8, 'MATCHBOX_SERVICE_LIGHTER');
  X.ChangeProperty(0, blobHostWin, X.atoms.WM_NAME, X.atoms.STRING, 8, 'XBLOB_HOST');

  X.ChangeProperty(0, lighterWin, matchboxTomlAtom, X.atoms.STRING, 8, matchboxToml);
  X.ChangeProperty(0, blobHostWin, matchboxTomlAtom, X.atoms.STRING, 8, blobhostMatchboxToml);

  X.ChangeProperty(0, lighterWin, serviceManifestTomlAtom, X.atoms.STRING, 8, TOML.stringify(xintentServicesManifesto));

  X.SetSelectionOwner(lighterWin, sessionSpeakersAtom, 0);
  logger.info(`Claimed SESSION_SPEAKERS selection for lighterWin (0x${lighterWin.toString(16)})`);

  const pidBuf = Buffer.alloc(4);
  pidBuf.writeUInt32LE(process.pid, 0);
  X.ChangeProperty(0, lighterWin, netWmPidAtom, X.atoms.CARDINAL, 32, pidBuf);
  X.ChangeProperty(0, blobHostWin, netWmPidAtom, X.atoms.CARDINAL, 32, pidBuf);
  logger.info(`Registered services (0x${lighterWin.toString(16)}) and dedicated XBlobHost window (0x${blobHostWin.toString(16)})`);

  const [routerWin] = await Promise.all([
    ensureXIntentRouter(X, root),
    ensureHttpBridge(),
    ensureXdgPortalBridge(),
  ]);

  if (routerWin) {
    await pickFiles.sendHostConnectFrame(routerWin);
  }

  rawX.on('event', async (ev) => {
    await handleClientMessageEvent({
      ev,
      X,
      lighterWin,
      atoms,
      packageRegistry,
      pickFiles,
      xaudioNode,
      trackChild,
    });
  });

  logger.info('Listening for incoming launch intents and XAudio commands...');
}

startLighter().catch(console.error);
