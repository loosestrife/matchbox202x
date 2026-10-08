// xintent-router/index.js
const {Logger, alStorage} = require('../server-tools');
const logger = new Logger({module: 'server.js'});

const {x11, X, rawX, root, routerWin} = require('.');
const {atoms, widString, connectToRouter, init: xintentInit} = require('../x11-promises/xintent');
xintentInit({logger: new Logger({module: 'libxintent'})});
const {handleXIntentIntentV0, handleXIntentEventV0, handleForwardingOfXChannelJsonFrame, parseWindowToml, parseWindowLighterToml, getAllMatchboxToml, xintentUnregisterWindow} = require('./xintent-router');
const {handleXBlobCreateV0, handleXBlobGrantV0, handleXBlobUnlinkV0, handleXBlobTransferV0, handleXAudioNodeRegisterV0, xblobUnlinkWindow, handleXBlobSoftLinkV0, handleXBlobSoftUnlinkV0, handleXBlobBroadcastV0} = require('./xblob');
const {handleXAudioGetAudioOutputsV0, handleXAudioPlayV0, handleXAudioControlV0, xaudioUnregisterWindow} = require('./xaudio');
const {checkXSecurePolicy} = require('./xsecure');

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
    'XINTENT_AGGREGATE_TOML',
    'XINTENT_SERVICES_MANIFEST',
    'XBLOB_CREATE_RESPONSE_V0',
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
    const existingRouterWin = await connectToRouter(X, root);
    if(existingRouterWin){
      logger.info('intent router already running', widString(routerWin));
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
    X.ChangeProperty(0, root, atoms.XINTENT, atoms.WINDOW, 32, winBuffer);
    X.SetSelectionOwner(routerWin, atoms.XINTENT, 0);
  }

  X.ChangeProperty(0, routerWin, atoms.WM_NAME, atoms.STRING, 8, 'XINTENT_ROUTER');
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

            // Attach parsed message to alStorage context
            logger.setContext({
              parsedMessage: parsed,
              intent: parsed.payload?.intent || parsed.payload?.event || parsed.payload?.action
            });

            logger.info(`parsed ${handler.name}`, parsed);
            const securityContext = await handler.securityContext(parsed);
            const securityPolicy = await checkXSecurePolicy(
              securityContext,
              parsed,
              ev
            );
            if (securityPolicy == 'accept') {
              handler.accept(parsed);
            }
            if (securityPolicy == '401') {
              // explicit deny response
              handler['401'](parsed);
            }
            if (securityPolicy == '404') {
              // pretend not to know what the sender was talking about
              handler['404'](parsed);
            }
            if (securityPolicy == 'drop') {
              // do nothing
            }
            if (securityPolicy == 'disconnect') {
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
      } else if (ev.atom === atoms.XINTENT_SERVICES_MANIFEST) {
        await parseWindowLighterToml(propWin);
      } else {
        try {
          const atomName = await X.GetAtomName(ev.atom);
          if (atomName === 'MATCHBOX_TOML') {
            await parseWindowToml(propWin);
          } else if (atomName === 'XINTENT_SERVICES_MANIFEST') {
            await parseWindowLighterToml(propWin);
          }
        } catch (_) {}
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
  logger.info('Listening for direct window IPC...');
}

startRouter().catch(logger.error);