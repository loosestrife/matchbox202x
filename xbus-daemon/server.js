// xbus-daemon/server.js
const {Logger, alStorage} = require('../server-tools');
const logger = new Logger({module: 'xbus-server'});
logger.setProjectName('xbus-daemon');

const {x11, X, rawX, root, routerWin} = require('.');
const {atoms, widString, frameType, frameDesc, connectToRouter, init: xintentInit} = require('../x11-promises/xintent');
xintentInit({logger: new Logger({module: 'libxintent'})});

const {handleXIntentIntentV0, handleXIntentEventV0, handleForwardingOfXChannelJsonFrame, parseWindowToml, parseWindowLighterToml, getAllMatchboxToml, xintentUnregisterWindow} = require('./xintent-router');
const {handleXBlobCreateV0, handleXBlobGrantV0, handleXBlobUnlinkV0, handleXBlobTransferV0, handleXAudioNodeRegisterV0, xblobUnlinkWindow, handleXBlobSoftLinkV0, handleXBlobSoftUnlinkV0, handleXBlobBroadcastV0, handleXBlobAnnounceHostV0, handleXBlobDropHostV0, handleXBlobHostConnectV0} = require('./xblob');
const {handleXAudioGetAudioOutputsV0, handleXAudioPlayV0, handleXAudioControlV0, xaudioUnregisterWindow} = require('./xaudio');

// Load Policy Engine from cool-intent-router
const policyEngine = require('../cool-intent-router');

async function startRouter() {
  const dispatchTable = {};
  const nonDispatchAtoms = [
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
  const dispatchAtoms = {
    'XINTENT_INTENT_V0': handleXIntentIntentV0,
    'XINTENT_EVENT_V0': handleForwardingOfXChannelJsonFrame,

    'XBLOB_CREATE_V0': handleXBlobCreateV0,
    'XBLOB_GRANT_V0': handleXBlobGrantV0,
    'XBLOB_UNLINK_V0': handleXBlobUnlinkV0,
    'XBLOB_TRANSFER_V0': handleXBlobTransferV0,
    'XBLOB_BROADCAST_V0': handleXBlobBroadcastV0,
    'XBLOB_SOFT_LINK_V0': handleXBlobSoftLinkV0,
    'XBLOB_SOFT_UNLINK_V0': handleXBlobSoftUnlinkV0,
    'XBLOB_ANNOUNCE_HOST_V0': handleXBlobAnnounceHostV0,
    'XBLOB_DROP_HOST_V0': handleXBlobDropHostV0,
    'XBLOB_HOST_CONNECT_V0': handleXBlobHostConnectV0,

    'XAUDIO_GET_AUDIO_OUTPUTS_V0': handleXAudioGetAudioOutputsV0,
    'XAUDIO_PLAY_V0': handleXAudioPlayV0,
    'XAUDIO_PLAY_RESPONSE_V0': handleForwardingOfXChannelJsonFrame,
    'XAUDIO_CONTROL_V0': handleXAudioControlV0,
  };
  await Promise.all(
    [...nonDispatchAtoms, ...Object.keys(dispatchAtoms)].map(async atom =>
      atoms[atom] = await X.InternAtom(false, atom)
    )
  );
  Object.keys(dispatchAtoms).forEach(atomName => {
    dispatchAtoms[atomName].name = atomName;
    dispatchTable[atoms[atomName]] = dispatchAtoms[atomName];
  });

  {
    const existingRouterWin = await connectToRouter(X, root, 0);
    if(existingRouterWin){
      logger.info('xbus-daemon already running', widString(routerWin));
      process.exit(0);
      return;
    }
    X.CreateWindow(
      routerWin, root,
      0, 0, 1, 1, 0, 0, 0, 0,
      { eventMask: x11.eventMask.PropertyChange }
    );
    const winBuffer = Buffer.alloc(4);
    winBuffer.writeUInt32LE(routerWin, 0);
    if (atoms.XCHANNEL) X.ChangeProperty(0, root, atoms.XCHANNEL, atoms.WINDOW, 32, winBuffer);
    if (atoms.XINTENT) X.ChangeProperty(0, root, atoms.XINTENT, atoms.WINDOW, 32, winBuffer);
    if (atoms.XCHANNEL) X.SetSelectionOwner(routerWin, atoms.XCHANNEL, 0);
    if (atoms.XINTENT) X.SetSelectionOwner(routerWin, atoms.XINTENT, 0);
    if (atoms.XBLOB_X_SERVER_LOCAL_BLOB_HOST) X.SetSelectionOwner(routerWin, atoms.XBLOB_X_SERVER_LOCAL_BLOB_HOST, 0);
    if (atoms.XBLOB_X_SERVER_LOCAL_XBLOB_HOST) X.SetSelectionOwner(routerWin, atoms.XBLOB_X_SERVER_LOCAL_XBLOB_HOST, 0);
  }

  X.ChangeProperty(0, routerWin, atoms.WM_NAME, atoms.STRING, 8, 'XCHANNEL_BUSMASTER');
  const pidBuf = Buffer.alloc(4);
  pidBuf.writeUInt32LE(process.pid, 0);
  X.ChangeProperty(0, routerWin, atoms._NET_WM_PID, atoms.CARDINAL, 32, pidBuf);

  logger.info('atoms are', atoms);
  X.ChangeWindowAttributes(root, { eventMask: x11.eventMask.SubstructureNotify });
  await getAllMatchboxToml();
  logger.info(`Window created: ${widString(routerWin)}`);

  // Per-client queue to enforce sequential message processing per sender window
  const clientQueues = new Map();

  function enqueueClientTask(clientId, taskFn, contextValues = {}) {
    const previous = clientQueues.get(clientId) || Promise.resolve();
    const current = previous
      .then(() => {
        return new Promise((resolve) => {
          alStorage.run(
            {
              values: {
                client: widString(clientId),
                ...contextValues,
              },
              timers: {
                start: new Date(),
              },
            },
            async () => {
              try {
                const res = await taskFn();
                resolve(res);
              } catch (err) {
                logger.error(`Error processing message for client ${widString(clientId)}:`, err);
                resolve();
              }
            }
          );
        });
      })
      .then(() => {
        if (clientQueues.get(clientId) === current) {
          clientQueues.delete(clientId);
        }
      });
    clientQueues.set(clientId, current);
    return current;
  }

  rawX.on('event', async (ev) => {
    if (ev.name === 'ClientMessage' && ev.wid === routerWin) {
      const msgTypeName =
        Object.keys(atoms).find((name) => atoms[name] === ev.message_type) ??
        ev.message_type;
      logger.info(
        `got ClientMessage type ${msgTypeName} sequence number ${ev.seq}`
      );
      if (ev.message_type in dispatchTable) {
        const clientId = ev.data[0];
        const txOrChannel = ev.data[1];
        const controlWord = ev.data[2];
        const payloadBlob = ev.data[3];
        const dataBlob = ev.data[4];

        enqueueClientTask(
          clientId,
          async () => {
            const handler = dispatchTable[ev.message_type];
            const parsed = await handler.parse(ev);
            if (parsed) {
              parsed.messageTypeAtom = ev.message_type;
              parsed.messageType = msgTypeName;
            }

            const intentName = parsed.payload?.intent || parsed.payload?.event || parsed.payload?.action || (parsed.payload?.data && typeof parsed.payload.data === 'object' ? (parsed.payload.data.intent || parsed.payload.data.event || parsed.data?.action) : undefined);

            // Attach intent name to alStorage context
            logger.setContext({
              intent: intentName
            });

            logger.info(`parsed ${frameDesc(parsed)}`, parsed);
            const securityContext = await handler.securityContext(parsed);

            // Evaluate policy via pluggable Policy Engine (cool-intent-router)
            let securityPolicy = 'accept';
            if (policyEngine && typeof policyEngine.checkXSecurePolicy === 'function') {
              securityPolicy = await policyEngine.checkXSecurePolicy(
                securityContext,
                parsed,
                ev,
                { X, atoms }
              );
            }

            if (securityPolicy === 'accept') {
              handler.accept(parsed);
            }
            if (securityPolicy === '401') {
              if (typeof handler['401'] === 'function') handler['401'](parsed);
            }
            if (securityPolicy === '404') {
              if (typeof handler['404'] === 'function') handler['404'](parsed);
            }
            if (securityPolicy === 'drop') {
              // do nothing
            }
            if (securityPolicy === 'disconnect') {
              logger.info(
                'disconnecting misbehaving client',
                widString(parsed.sender)
              );
            }
          },
          {
            messageType: msgTypeName,
            sender: widString(clientId),
            target: widString(ev.wid),
            payloadBlob: widString(payloadBlob),
            ...(dataBlob ? { dataBlob: widString(dataBlob) } : {}),
          }
        );
      } else {
        logger.warn('unknown message type', ev);
      }
    }

    if (ev.name === 'CreateNotify') {
      const createdWin = ev.window || ev.wid;
      try {
        X.ChangeWindowAttributes(createdWin, { eventMask: x11.eventMask.PropertyChange });
      } catch (_) {}
      await parseWindowToml(createdWin);
      await parseWindowLighterToml(createdWin);
    }

    if (ev.name === 'PropertyNotify') {
      const propWin = ev.window || ev.wid;
      if (ev.atom === atoms.MATCHBOX_TOML) {
        await parseWindowToml(propWin);
      } else if (ev.atom === atoms.SERVICE_MANIFEST_TOML) {
        await parseWindowLighterToml(propWin);
      }
    }

    if (ev.name === 'DestroyNotify') {
      xintentUnregisterWindow(ev.wid);
      xblobUnlinkWindow(ev.wid);
      xaudioUnregisterWindow(ev.wid);
    }

    if (ev.name === 'SelectionClear' && ev.selection === atoms.XINTENT) {
      logger.warn('Lost XINTENT selection ownership to another router. Exiting...');
      process.exit(0);
    }
  });
  logger.info('xbus-daemon listening for direct window IPC...');
}

startRouter().catch(logger.error);
