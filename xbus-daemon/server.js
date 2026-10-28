// xbus-daemon/server.js
const { Logger, alStorage } = require('../server-tools');
const logger = new Logger({ module: 'xbus-server' });
logger.setProjectName('xbus-daemon');

const daemon = require('.');
const xintent = require('../x11-promises/xintent');
xintent.init({ logger: new Logger({ module: 'libxintent' }) });

const router = require('./xintent-router');
const xblob = require('./xblob');
const xaudio = require('./xaudio');
const policyEngine = require('../cool-intent-router');

const NON_DISPATCH_ATOMS = [
  'STRING',
  'WM_NAME',
  'WM_CLASS',
  'WINDOW',
  'CARDINAL',
  '_NET_WM_PID',
  'XINTENT',
  'XINTENT_DATA',
  'MATCHBOX_TOML',
  'AGGREGATE_TOML',
  'SERVICE_MANIFEST_TOML',
  'XBLOB_CREATE_RESPONSE_V0',
  'XBLOB_X_SERVER_LOCAL_BLOB_HOST',
  'XBLOB_X_SERVER_LOCAL_XBLOB_HOST',
];

function buildDispatchAtomsMap() {
  return {
    XINTENT_INTENT_V0: router.handleXIntentIntentV0,
    XINTENT_EVENT_V0: router.handleForwardingOfXChannelJsonFrame,
    XBLOB_CREATE_V0: xblob.handleXBlobCreateV0,
    XBLOB_GRANT_V0: xblob.handleXBlobGrantV0,
    XBLOB_UNLINK_V0: xblob.handleXBlobUnlinkV0,
    XBLOB_TRANSFER_V0: xblob.handleXBlobTransferV0,
    XBLOB_BROADCAST_V0: xblob.handleXBlobBroadcastV0,
    XBLOB_SOFT_LINK_V0: xblob.handleXBlobSoftLinkV0,
    XBLOB_SOFT_UNLINK_V0: xblob.handleXBlobSoftUnlinkV0,
    XBLOB_ANNOUNCE_HOST_V0: xblob.handleXBlobAnnounceHostV0,
    XBLOB_DROP_HOST_V0: xblob.handleXBlobDropHostV0,
    XBLOB_HOST_CONNECT_V0: xblob.handleXBlobHostConnectV0,
    XAUDIO_GET_AUDIO_OUTPUTS_V0: xaudio.handleXAudioGetAudioOutputsV0,
    XAUDIO_PLAY_V0: xaudio.handleXAudioPlayV0,
    XAUDIO_PLAY_RESPONSE_V0: router.handleForwardingOfXChannelJsonFrame,
    XAUDIO_CONTROL_V0: xaudio.handleXAudioControlV0,
  };
}

async function internAndBuildDispatchTable() {
  const dispatchTable = {};
  const dispatchAtoms = buildDispatchAtomsMap();
  const allAtomNames = [...NON_DISPATCH_ATOMS, ...Object.keys(dispatchAtoms)];
  await Promise.all(
    allAtomNames.map(async (atom) => {
      xintent.atoms[atom] = await daemon.X.InternAtom(false, atom);
    })
  );
  for (const atomName of Object.keys(dispatchAtoms)) {
    dispatchAtoms[atomName].name = atomName;
    dispatchTable[xintent.atoms[atomName]] = dispatchAtoms[atomName];
  }
  return dispatchTable;
}

async function registerRouterWindowAndSelections() {
  const { X, root, routerWin, x11 } = daemon;
  const { atoms } = xintent;
  const existingRouterWin = await xintent.connectToRouter(X, root, 0);
  if (existingRouterWin) {
    logger.info('xbus-daemon already running', xintent.widString(routerWin));
    process.exit(0);
    return;
  }
  X.CreateWindow(routerWin, root, 0, 0, 1, 1, 0, 0, 0, 0, { eventMask: x11.eventMask.PropertyChange });
  const winBuffer = Buffer.alloc(4);
  winBuffer.writeUInt32LE(routerWin, 0);

  for (const propAtom of [atoms.XCHANNEL, atoms.XINTENT].filter(Boolean)) {
    X.ChangeProperty(0, root, propAtom, atoms.WINDOW, 32, winBuffer);
  }
  const selectionAtoms = [
    atoms.XCHANNEL,
    atoms.XINTENT,
    atoms.XBLOB_X_SERVER_LOCAL_BLOB_HOST,
    atoms.XBLOB_X_SERVER_LOCAL_XBLOB_HOST,
  ].filter(Boolean);
  for (const selAtom of selectionAtoms) {
    X.SetSelectionOwner(routerWin, selAtom, 0);
  }

  X.ChangeProperty(0, routerWin, atoms.WM_NAME, atoms.STRING, 8, 'XCHANNEL_BUSMASTER');
  const pidBuf = Buffer.alloc(4);
  pidBuf.writeUInt32LE(process.pid, 0);
  X.ChangeProperty(0, routerWin, atoms._NET_WM_PID, atoms.CARDINAL, 32, pidBuf);
}

function extractIntentNameFromParsed(parsed) {
  const p = parsed?.payload;
  if (!p) return undefined;
  if (p.intent || p.event || p.action) return p.intent || p.event || p.action;
  if (p.data && typeof p.data === 'object') {
    return p.data.intent || p.data.event || parsed.data?.action;
  }
  return undefined;
}

function applySecurityDecision(securityPolicy, handler, parsed) {
  if (securityPolicy === 'accept') {
    handler.accept(parsed);
  } else if ((securityPolicy === '401' || securityPolicy === '404') && typeof handler[securityPolicy] === 'function') {
    handler[securityPolicy](parsed);
  } else if (securityPolicy === 'disconnect') {
    logger.info('disconnecting misbehaving client', xintent.widString(parsed.sender));
  }
}

async function processDispatchedClientMessage(ev, msgTypeName, handler) {
  const parsed = await handler.parse(ev);
  if (parsed) {
    parsed.messageTypeAtom = ev.message_type;
    parsed.messageType = msgTypeName;
  }

  logger.setContext({ intent: extractIntentNameFromParsed(parsed) });
  logger.info(`parsed ${xintent.frameDesc(parsed)}`, parsed);

  const securityContext = await handler.securityContext(parsed);
  let securityPolicy = 'accept';
  if (policyEngine && typeof policyEngine.checkXSecurePolicy === 'function') {
    securityPolicy = await policyEngine.checkXSecurePolicy(
      securityContext,
      parsed,
      ev,
      { X: daemon.X, atoms: xintent.atoms }
    );
  }
  applySecurityDecision(securityPolicy, handler, parsed);
}

function handleRouterClientMessage(ev, dispatchTable, enqueueClientTask) {
  const { atoms, widString } = xintent;
  const msgTypeName = Object.keys(atoms).find((name) => atoms[name] === ev.message_type) ?? ev.message_type;
  logger.info(`got ClientMessage type ${msgTypeName} sequence number ${ev.seq}`);

  if (!(ev.message_type in dispatchTable)) {
    logger.warn('unknown message type', ev);
    return;
  }

  const [clientId, , , payloadBlob, dataBlob] = ev.data;
  const handler = dispatchTable[ev.message_type];
  enqueueClientTask(
    clientId,
    () => processDispatchedClientMessage(ev, msgTypeName, handler),
    {
      messageType: msgTypeName,
      sender: widString(clientId),
      target: widString(ev.wid),
      payloadBlob: widString(payloadBlob),
      ...(dataBlob ? { dataBlob: widString(dataBlob) } : {}),
    }
  );
}

async function handleLifecycleEvent(ev) {
  const { X, x11 } = daemon;
  const { atoms } = xintent;
  if (ev.name === 'CreateNotify') {
    const createdWin = ev.window || ev.wid;
    try {
      X.ChangeWindowAttributes(createdWin, { eventMask: x11.eventMask.PropertyChange });
    } catch (_) {}
    await router.parseWindowToml(createdWin);
    await router.parseWindowLighterToml(createdWin);
    return;
  }
  if (ev.name === 'PropertyNotify') {
    const propWin = ev.window || ev.wid;
    if (ev.atom === atoms.MATCHBOX_TOML) await router.parseWindowToml(propWin);
    else if (ev.atom === atoms.SERVICE_MANIFEST_TOML) await router.parseWindowLighterToml(propWin);
    return;
  }
  if (ev.name === 'DestroyNotify') {
    router.xintentUnregisterWindow(ev.wid);
    xblob.xblobUnlinkWindow(ev.wid);
    xaudio.xaudioUnregisterWindow(ev.wid);
  }
}

async function startRouter() {
  const dispatchTable = await internAndBuildDispatchTable();
  await registerRouterWindowAndSelections();

  logger.info('atoms are', xintent.atoms);
  daemon.X.ChangeWindowAttributes(daemon.root, { eventMask: daemon.x11.eventMask.SubstructureNotify });
  await router.getAllMatchboxToml();
  logger.info(`Window created: ${xintent.widString(daemon.routerWin)}`);

  const clientQueues = new Map();

  function enqueueClientTask(clientId, taskFn, contextValues = {}) {
    const previous = clientQueues.get(clientId) || Promise.resolve();
    const current = previous
      .then(() => new Promise((resolve) => {
        alStorage.run(
          {
            values: { client: xintent.widString(clientId), ...contextValues },
            timers: { start: new Date() },
          },
          async () => {
            try {
              resolve(await taskFn());
            } catch (err) {
              logger.error(`Error processing message for client ${xintent.widString(clientId)}:`, err);
              resolve();
            }
          }
        );
      }))
      .then(() => {
        if (clientQueues.get(clientId) === current) clientQueues.delete(clientId);
      });
    clientQueues.set(clientId, current);
    return current;
  }

  daemon.rawX.on('event', async (ev) => {
    if (ev.name === 'ClientMessage' && ev.wid === daemon.routerWin) {
      handleRouterClientMessage(ev, dispatchTable, enqueueClientTask);
      return;
    }
    if (ev.name === 'SelectionClear' && ev.selection === xintent.atoms.XINTENT) {
      logger.warn('Lost XINTENT selection ownership to another router. Exiting...');
      process.exit(0);
      return;
    }
    await handleLifecycleEvent(ev);
  });

  logger.info('xbus-daemon listening for direct window IPC...');
}

startRouter().catch(logger.error);
