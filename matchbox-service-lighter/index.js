// matchbox-service-lighter/index.js
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const util = require('util');
const TOML = require('@iarna/toml');
const {intentRegistry, packageRegistry, buildRegistries, xintentServicesManifesto} = require('./intent-registry');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');
const {Logger, alStorage} = require('../server-tools');
const pickFiles = require('./xblob-host');
const xaudioNode = require('./xaudio-node');

xintent.init({logger: new Logger({module: 'libxintent'})});
const logger = new Logger({module: 'index.js'});
logger.setProjectName('service-lighter')

logger.info('got manifesto', TOML.stringify(xintentServicesManifesto));

const hostname = os.hostname();
const matchboxToml = `
[app]
id = "matchbox-service-lighter"

[intents]
"sys.Launch" = true
"fs.PickFile" = true
"fs.PickFilePath" = true
"xaudio.PlaySoundBlob" = true
"xaudio.PrefetchSoundBlob" = true
"xaudio.PlayStream" = true
"xaudio.ControlStream" = true
"xaudio.SeekStream" = true

[XBlobHost]
host = "${hostname}"

[XAudioSink]
name = "${hostname}-speakers"
`;

const children = new Set();

function trackChild(proc) {
  if (!proc || !proc.pid) return proc;
  children.add(proc);
  const cleanup = () => children.delete(proc);
  proc.on('exit', cleanup);
  proc.on('error', cleanup);
  return proc;
}

function killChild(proc, signal = 'SIGINT') {
  if (!proc || !proc.pid) return;
  try {
    if (proc.detached) {
      try {
        process.kill(-proc.pid, signal);
      } catch (_) {
        proc.kill(signal);
      }
    } else {
      proc.kill(signal);
    }
  } catch (_) {}
}

function forwardSignalAndExit(signal) {
  logger.info(`Received ${signal}. Forwarding to ${children.size} child process(es)...`);
  for (const proc of children) {
    killChild(proc, signal);
  }
  children.clear();
  process.exit(0);
}

process.on('SIGINT', () => forwardSignalAndExit('SIGINT'));
process.on('SIGTERM', () => forwardSignalAndExit('SIGTERM'));

function checkHttpBridge(port = 12345) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/tags`, { timeout: 1000 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function spawnRuntime(cmdFile, workingDir) {
  try {
    const proc = spawn('bun', [cmdFile], {
      cwd: workingDir,
      stdio: 'inherit',
      detached: true,
    });
    trackChild(proc);
    proc.on('error', () => {
      const fallbackProc = spawn('node', [cmdFile], {
        cwd: workingDir,
        stdio: 'inherit',
        detached: true,
      });
      trackChild(fallbackProc);
    });
    return proc;
  } catch (_) {
    const fallbackProc = spawn('node', [cmdFile], {
      cwd: workingDir,
      stdio: 'inherit',
      detached: true,
    });
    trackChild(fallbackProc);
    return fallbackProc;
  }
}

async function ensureXIntentRouter(X, root) {
  let routerWin = await xintent.connectToRouter(X, root);
  if (!routerWin) {
    logger.info('[service-lighter] xintent-router not detected. Auto-launching xintent-router...');
    const routerDir = path.join(__dirname, '../xintent-router');
    const entryFile = path.join(routerDir, 'index.js');

    spawnRuntime(entryFile, routerDir);

    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      routerWin = await xintent.connectToRouter(X, root);
      if (routerWin) {
        logger.info(`[service-lighter] Connected to auto-launched xintent-router (0x${routerWin.toString(16)})`);
        break;
      }
    }
  } else {
    logger.info(`[service-lighter] Connected to existing xintent-router (0x${routerWin.toString(16)})`);
  }
  return routerWin;
}

async function ensureHttpBridge() {
  const isRunning = await checkHttpBridge(12345);
  if (!isRunning) {
    logger.info('[service-lighter] http-bridge not detected on port 12345. Auto-launching http-bridge...');
    const bridgeDir = path.join(__dirname, '../http-bridge');
    const entryFile = path.join(bridgeDir, 'index.js');

    spawnRuntime(entryFile, bridgeDir);
    logger.info('[service-lighter] Auto-launched http-bridge service on port 12345.');
  } else {
    logger.info('[service-lighter] http-bridge is active on http://localhost:12345.');
  }
}

async function startLighter() {
  const { X, rawX, root } = await x11.createClientWithPromises();

  const lighterWin = X.AllocID();
  X.CreateWindow(
    lighterWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  pickFiles.init({X, lighterWin, trackChild});
  xaudioNode.init({X, lighterWin, trackChild});

  const xintentServicesManifestAtom = await X.InternAtom(false, 'XINTENT_SERVICES_MANIFEST');
  const xintentMatchboxTomlAtom = await X.InternAtom(false, 'MATCHBOX_TOML');
  const netWmPidAtom = await X.InternAtom(false, '_NET_WM_PID');

  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentIntentV0Atom = await X.InternAtom(false, 'XINTENT_INTENT_V0');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');

  const xblobDestructorAtom = await X.InternAtom(false, 'XBLOB_DESTRUCTOR_V0');
  const xblobBroadcastAtom = await X.InternAtom(false, 'XBLOB_BROADCAST_V0');

  const xaudioPlaySoundBlobAtom = await X.InternAtom(false, 'XAUDIO_PLAY_SOUND_BLOB_V0');
  const xaudioPrefetchSoundBlobAtom = await X.InternAtom(false, 'XAUDIO_PREFETCH_SOUND_BLOB_V0');
  const xaudioPlayStreamAtom = await X.InternAtom(false, 'XAUDIO_PLAY_STREAM_V0');
  const xaudioControlStreamAtom = await X.InternAtom(false, 'XAUDIO_CONTROL_STREAM_V0');
  const xaudioSeekStreamAtom = await X.InternAtom(false, 'XAUDIO_SEEK_STREAM_V0');

  X.ChangeProperty(0, lighterWin, X.atoms.WM_NAME, X.atoms.STRING, 8, 'MATCHBOX_SERVICE_LIGHTER');
  X.ChangeProperty(0, lighterWin, xintentServicesManifestAtom, X.atoms.STRING, 8, TOML.stringify(xintentServicesManifesto));
  X.ChangeProperty(0, lighterWin, xintentMatchboxTomlAtom, X.atoms.STRING, 8, matchboxToml);

  const pidBuf = Buffer.alloc(4);
  pidBuf.writeUInt32LE(process.pid, 0);
  X.ChangeProperty(0, lighterWin, netWmPidAtom, X.atoms.CARDINAL, 32, pidBuf);
  logger.info(`Registered services (0x${lighterWin.toString(16)})`);

  await ensureXIntentRouter(X, root);
  await ensureHttpBridge();

  // 4. Handle Direct Start Signals & XAudio Commands from xintent-router
  rawX.on('event', async (ev) => {
    if ((ev.type === 33 || ev.name === 'ClientMessage') && ev.wid === lighterWin) {
      alStorage.run(
        {
          values: {
            msgType: ev.message_type,
            seq: ev.seq,
          },
          timers: {
            start: new Date()
          }
        },
        async () => {
          try {
            if (ev.message_type == xintentIntentV0Atom) {
              const xintentIntent = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
              const payload = xintentIntent.payload;
              const intentName = payload.intent || payload.action || payload.event;
              logger.setContext({
                intent: intentName,
                sender: xintent.widString(xintentIntent.senderWin),
                channel: xintentIntent.channel,
              });

              if (intentName === "sys.Launch") {
                const pakName = payload.package;
                const package = packageRegistry[pakName];
                const intent = package.intents[payload.intendedIntent];
                logger.setContext({ package: pakName, intendedIntent: payload.intendedIntent });
                logger.info(`Got request to load ${pakName} for ${payload.intendedIntent}`, intent);

                const proc = spawn(intent.exec, {shell: true, cwd: package._path || process.cwd(), stdio: 'inherit'});
                trackChild(proc);
                proc.on('error', err => {
                  logger.error(`Failed to launch service:`, err);
                });
              }
              else if (intentName === "fs.PickFilePath") {
                await pickFiles.pickFilePath(xintentIntent);
              }
              else if (intentName === "fs.PickFile") {
                await pickFiles.pickFile(xintentIntent);
              }
              else if (["xaudio.PlaySoundBlob", "XAudioPlaySoundBlob", "XAudioPlaySoundBlobV0"].includes(intentName)) {
                await xaudioNode.playSoundBlob(payload, xintentIntent.senderWin);
              }
              else if (["xaudio.PrefetchSoundBlob", "XAudioPrefetchSoundBlob", "XAudioPrefetchSoundBlobV0"].includes(intentName)) {
                await xaudioNode.prefetchSoundBlob(payload);
              }
              else if (["xaudio.PlayStream", "PlayStream", "XAudioPlayStreamV0"].includes(intentName)) {
                await xaudioNode.playStream(payload, xintentIntent.senderWin);
              }
              else if (["xaudio.ControlStream", "ControlStream", "XAudioControlStreamV0"].includes(intentName)) {
                await xaudioNode.controlStream(payload);
              }
              else if (["xaudio.SeekStream", "SeekStream", "XAudioSeekStreamV0"].includes(intentName)) {
                await xaudioNode.seekStream(payload);
              }
              else {
                logger.warn("unknown intent", intentName);
                return;
              }
            }
            else if (ev.message_type == xaudioPlaySoundBlobAtom) {
              const { payload, senderWin } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
              logger.setContext({ intent: 'xaudio.PlaySoundBlob' });
              await xaudioNode.playSoundBlob(payload, senderWin);
            }
            else if (ev.message_type == xaudioPrefetchSoundBlobAtom) {
              const { payload } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
              logger.setContext({ intent: 'xaudio.PrefetchSoundBlob' });
              await xaudioNode.prefetchSoundBlob(payload);
            }
            else if (ev.message_type == xaudioPlayStreamAtom) {
              const { payload, senderWin } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
              logger.setContext({ intent: 'xaudio.PlayStream' });
              await xaudioNode.playStream(payload, senderWin);
            }
            else if (ev.message_type == xaudioControlStreamAtom) {
              const { payload } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
              logger.setContext({ intent: 'xaudio.ControlStream' });
              await xaudioNode.controlStream(payload);
            }
            else if (ev.message_type == xaudioSeekStreamAtom) {
              const { payload } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
              logger.setContext({ intent: 'xaudio.SeekStream' });
              await xaudioNode.seekStream(payload);
            }
            else if (ev.message_type == xblobBroadcastAtom) {
              const frame = xintent.parseXBlobBroadcastFrame(X, xintent.routerWin, ev);
              logger.setContext({ event: 'XBLOB_BROADCAST', blob: xintent.widString(frame.blob) });
              await pickFiles.xblobBroadcast(frame);
            }
            else if (ev.message_type == xblobDestructorAtom) {
              const frame = xintent.parseXBlobDestructorFrame(X, xintent.routerWin, ev);
              logger.setContext({ event: 'XBLOB_DESTRUCTOR', blob: xintent.widString(frame.blob) });
              await pickFiles.xblobDestructor(frame);
            }
            else {
              logger.error(`got unknown message type atom ${ev.message_type}`);
            }
          } catch (err) {
            logger.error(`Error processing ClientMessage event:`, err);
          }
        }
      );
    }
  });

  logger.info('Listening for incoming launch intents and XAudio commands...');
}

startLighter().catch(console.error);
