// cool-service-lighter/index.js
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const util = require('util');
const TOML = require('@iarna/toml');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');
const {Logger, alStorage} = require('../server-tools');
const pickFiles = require('./xblob-host');
const xaudioNode = require('./xaudio-node');
const logger = new Logger({module: 'index.js'});
xintent.init({logger: new Logger({module: 'libxintent'})});
logger.setProjectName('cool-service-lighter')

const {intentRegistry, packageRegistry, buildRegistries, xintentServicesManifesto} = require('./intent-registry');
logger.info('got manifesto', TOML.stringify(xintentServicesManifesto));

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
    const req = http.get(`http://localhost:${port}/api/tags`, { timeout: 200 }, (res) => {
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

async function ensureXBusDaemon(X, root) {
  let routerWin = await xintent.connectToRouter(X, root, 0);
  if (!routerWin) {
    logger.info('[cool-service-lighter] xbus-daemon not detected on XCHANNEL atom. Auto-launching xbus-daemon...');
    const busDir = path.join(__dirname, '../xbus-daemon');
    const busEntryFile = path.join(busDir, 'index.js');

    if (fs.existsSync(busEntryFile)) {
      spawnRuntime(busEntryFile, busDir);
    } else {
      const routerDir = path.join(__dirname, '../cool-intent-router');
      const entryFile = path.join(routerDir, 'index.js');
      spawnRuntime(entryFile, routerDir);
    }

    // Event-driven wait: listen for X11 PropertyNotify on root window when xbus-daemon claims XCHANNEL
    routerWin = await new Promise((resolve) => {
      const eventHandler = async (ev) => {
        if (ev.name === 'PropertyNotify' && ev.wid === root) {
          const win = await xintent.connectToRouter(X, root, 0);
          if (win) {
            X.removeListener('event', eventHandler);
            resolve(win);
          }
        }
      };

      X.on('event', eventHandler);

      // Safety fallback timeout in case process fails to launch
      setTimeout(async () => {
        X.removeListener('event', eventHandler);
        resolve(await xintent.connectToRouter(X, root, 0));
      }, 3000);
    });

    if (routerWin) {
      logger.info(`[cool-service-lighter] Connected to auto-launched xbus-daemon (0x${routerWin.toString(16)})`);
    } else {
      logger.warn('[cool-service-lighter] xbus-daemon startup timed out.');
    }
  } else {
    logger.info(`[cool-service-lighter] Connected to existing xbus-daemon (0x${routerWin.toString(16)})`);
  }

  // Once xbus-daemon is confirmed active, auto-launch cool-intent-router Policy Engine
  const routerDir = path.join(__dirname, '../cool-intent-router');
  const routerEntryFile = path.join(routerDir, 'index.js');
  if (fs.existsSync(routerEntryFile)) {
    logger.info('[cool-service-lighter] Auto-launching cool-intent-router Policy Engine...');
    spawnRuntime(routerEntryFile, routerDir);
  }

  return routerWin;
}

async function ensureXIntentRouter(X, root) {
  return ensureXBusDaemon(X, root);
}

async function ensureHttpBridge() {
  const isRunning = await checkHttpBridge(12345);
  if (!isRunning) {
    logger.info('[cool-service-lighter] cool-http-bridge not detected on port 12345. Auto-launching cool-http-bridge...');
    const bridgeDir = path.join(__dirname, '../cool-http-bridge');
    const entryFile = path.join(bridgeDir, 'index.js');

    spawnRuntime(entryFile, bridgeDir);
    logger.info('[cool-service-lighter] Auto-launched cool-http-bridge service on port 12345.');
  } else {
    logger.info('[cool-service-lighter] cool-http-bridge is active on http://localhost:12345.');
  }
}

async function ensureXdgPortalBridge() {
  const portalBridgeDir = path.join(__dirname, '../xdg-portal-bridge');
  const entryFile = path.join(portalBridgeDir, 'xintent-portal-daemon.py');

  if (fs.existsSync(entryFile)) {
    logger.info('[cool-service-lighter] Auto-launching xdg-portal-bridge...');
    try {
      const pyprojectFile = path.join(portalBridgeDir, 'pyproject.toml');
      const hasUv = fs.existsSync(pyprojectFile);
      const cmd = hasUv ? 'uv' : 'python3';
      const args = hasUv ? ['run', 'xintent-portal-daemon.py'] : ['xintent-portal-daemon.py'];

      const proc = spawn(cmd, args, {
        cwd: portalBridgeDir,
        stdio: 'inherit',
        detached: true,
      });
      trackChild(proc);
      logger.info(`[cool-service-lighter] Auto-launched xdg-portal-bridge service using ${cmd}.`);
    } catch (err) {
      logger.error('[cool-service-lighter] Failed to launch xdg-portal-bridge:', err);
    }
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

  const blobHostWin = X.AllocID();
  X.CreateWindow(
    blobHostWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  pickFiles.init({X, lighterWin, blobHostWin, trackChild});
  xaudioNode.init({X, lighterWin, sinkName, trackChild});

  const serviceManifestTomlAtom = await X.InternAtom(false, 'SERVICE_MANIFEST_TOML');
  const matchboxTomlAtom = await X.InternAtom(false, 'MATCHBOX_TOML');
  const netWmPidAtom = await X.InternAtom(false, '_NET_WM_PID');

  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentIntentV0Atom = await X.InternAtom(false, 'XINTENT_INTENT_V0');
  const xintentEventV0Atom = await X.InternAtom(false, 'XINTENT_EVENT_V0');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');

  const xblobDestructorAtom = await X.InternAtom(false, 'XBLOB_DESTRUCTOR_V0');
  const xblobBroadcastAtom = await X.InternAtom(false, 'XBLOB_BROADCAST_V0');
  const xblobCreateResponseAtom = await X.InternAtom(false, 'XBLOB_CREATE_RESPONSE_V0');

  const sessionSpeakersAtom = await X.InternAtom(false, 'SESSION_SPEAKERS');

  const xaudioPlaySoundBlobAtom = await X.InternAtom(false, 'XAUDIO_PLAY_V0');
  const xaudioPrefetchSoundBlobAtom = await X.InternAtom(false, 'XAUDIO_PREFETCH_SOUND_BLOB_V0');
  const xaudioPlayStreamAtom = await X.InternAtom(false, 'XAUDIO_PLAY_STREAM_V0');
  const xaudioControlStreamAtom = await X.InternAtom(false, 'XAUDIO_CONTROL_V0');
  const xaudioSeekStreamAtom = await X.InternAtom(false, 'XAUDIO_SEEK_STREAM_V0');
  
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

  await Promise.all([
    ensureXIntentRouter(X, root),
    ensureHttpBridge(),
    ensureXdgPortalBridge(),
  ]);

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
            if (ev.message_type == xintentIntentV0Atom || ev.message_type == xintentEventV0Atom) {
              const xintentIntent = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
              const payload = xintentIntent.payload;
              const intentName = payload?.intent || payload?.action || payload?.event || (payload?.data && typeof payload.data === 'object' ? (payload.data.intent || payload.data.action || payload.data.event) : undefined);
              logger.setContext({
                intent: intentName,
                sender: xintent.widString(xintentIntent.senderWin),
                channel: xintentIntent.channel,
              });

              if (intentName === "sys.Launch") {
                const pakName = payload.package || (payload.data && payload.data.package);
                const package = packageRegistry[pakName];
                const intendedIntent = payload.intendedIntent || (payload.data && payload.data.intendedIntent);
                const intent = package ? package.intents[intendedIntent] : undefined;
                logger.setContext({ package: pakName, intendedIntent: intendedIntent });
                logger.info(`Got request to load ${pakName} for ${intendedIntent}`, intent);

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
              else if (["xaudio.PlaySoundBlob", "XAudioPlaySoundBlob", "XAudioPlaySoundBlobV0", "XAudioPlayV0", "XAudioPlay", "xaudio.Play"].includes(intentName)) {
                await xaudioNode.playSoundBlob(payload, xintentIntent.senderWin, xintentIntent.dataBlob, xintentIntent.channel);
              }
              else if (["xaudio.PrefetchSoundBlob", "XAudioPrefetchSoundBlob", "XAudioPrefetchSoundBlobV0", "XAudioPrefetch"].includes(intentName)) {
                await xaudioNode.prefetchSoundBlob(payload, xintentIntent.dataBlob);
              }
              else if (["xaudio.PlayStream", "PlayStream", "XAudioPlayStreamV0"].includes(intentName)) {
                await xaudioNode.playStream(payload, xintentIntent.senderWin, xintentIntent.dataBlob, xintentIntent.channel);
              }
              else if (["xaudio.ControlStream", "ControlStream", "XAudioControlStreamV0", "XAudioControlV0", "XAudioControl", "xaudio.Control"].includes(intentName)) {
                await xaudioNode.controlStream(payload, xintentIntent.channel, xintentIntent.controlWord);
              }
              else if (["xaudio.SeekStream", "SeekStream", "XAudioSeekStreamV0", "XAudioSeekV0"].includes(intentName)) {
                await xaudioNode.seekStream(payload);
              }
              else {
                logger.warn("unknown intent", intentName);
                return;
              }
            }
            else if (ev.message_type == xaudioPlaySoundBlobAtom) {
              const { payload, senderWin, dataBlob, channel } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
              logger.setContext({ intent: 'xaudio.Play' });
              await xaudioNode.playSoundBlob(payload, senderWin, dataBlob, channel);
            }
            else if (ev.message_type == xaudioPrefetchSoundBlobAtom) {
              const { payload } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
              logger.setContext({ intent: 'xaudio.PrefetchSoundBlob' });
              await xaudioNode.prefetchSoundBlob(payload);
            }
            else if (ev.message_type == xaudioPlayStreamAtom) {
              const { payload, senderWin } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
              logger.setContext({ intent: 'xaudio.PlayStream' });
              await xaudioNode.playStream(payload, senderWin);
            }
            else if (ev.message_type == xaudioControlStreamAtom) {
              const { payload, channel, controlWord } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
              logger.setContext({ intent: 'xaudio.ControlStream' });
              await xaudioNode.controlStream(payload, channel, controlWord);
            }
            else if (ev.message_type == xaudioSeekStreamAtom) {
              const { payload } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
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
            else if (ev.message_type == xblobCreateResponseAtom || ev.message_type == xintentDataAtom) {
              // Response confirmation and data notification atoms handled by x11 response listeners
              return;
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
