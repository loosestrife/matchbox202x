// xintent-router/index.js

const {x11, X, rawX, root, routerWin} = require('.');
const {atoms, widString, connectToRouter} = require('../x11-promises/xintent');
const {handleXIntentIntentV0, handleXIntentEventV0, parseWindowToml, parseWindowLighterToml, getAllMatchboxToml, xintentUnregisterWindow} = require('./xintent-router');
const {handleXBlobCreateV0, handleXBlobGrantV0, handleXBlobUnlinkV0, handleXBlobTransferV0, handleXAudioNodeRegisterV0, xblobUnlinkWindow} = require('./xblob');
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
    'XINTENT_MATCHBOX_TOML',
    'XINTENT_SERVICES_MANIFEST',
    'XBLOB_CREATE_RESPONSE_V0',
  ];
  const dispatchAtoms = {
    'XINTENT_INTENT_V0': handleXIntentIntentV0,
    'XINTENT_EVENT_V0': handleXIntentEventV0,

    'XBLOB_CREATE_V0': handleXBlobCreateV0,
    'XBLOB_GRANT_V0': handleXBlobGrantV0,
    'XBLOB_UNLINK_V0': handleXBlobUnlinkV0,
    'XBLOB_TRANSFER_V0': handleXBlobTransferV0,
    'XAUDIO_NODE_REGISTER_V0': handleXAudioNodeRegisterV0,

    'XAUDIO_GET_AUDIO_OUTPUTS_V0': handleXAudioGetAudioOutputsV0,
    'XAUDIO_PLAY_V0': handleXAudioPlayV0,
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
      console.log('intent router already running', widString(routerWin));
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

  console.log('atoms are', atoms);
  X.ChangeWindowAttributes(root, { eventMask: x11.eventMask.SubstructureNotify });
  await getAllMatchboxToml();
  console.log(`[intent-router] Window created: ${widString(routerWin)}`);


  // Per-client queue to enforce sequential message processing per sender window
  const clientQueues = new Map();

  function enqueueClientTask(clientId, taskFn) {
    const previous = clientQueues.get(clientId) || Promise.resolve();
    const current = previous
      .then(taskFn)
      .catch(err => {
        console.error(`[router] Error processing message for client ${clientId}:`, err);
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
      console.log(`got ClientMessage type ${
        Object.keys(atoms).find(name => atoms[name] === ev.message_type) ?? ev.message_type
      } sequence number ${ev.seq}`);
      if (ev.message_type in dispatchTable){
        const clientId = ev.data[0];
        enqueueClientTask(clientId, async () => {
          const handler = dispatchTable[ev.message_type];
          const parsed = await handler.parse(ev);
          console.log(`parsed ${handler.name}`, parsed);
          const securityContext = await handler.securityContext(parsed);
          const securityPolicy = await checkXSecurePolicy(securityContext, parsed, ev);
          if(securityPolicy == 'accept'){
            handler.accept(parsed);
          }
          if(securityPolicy == '401'){
            // explicit deny response
            handler['401'](parsed);
          }
          if(securityPolicy == '404'){
            // pretend not to know what the sender was talking about
            handler['404'](parsed);
          }
          if(securityPolicy == 'drop'){
            // do nothing
          }
          if(securityPolicy == 'disconnect'){
            console.log('disconnecting misbehaving client', widString(parsed.sender));
          }
        });
      } else {
        console.log("unknown message type", ev);
      }
    }

    if (ev.name === 'CreateNotify') {
      X.ChangeWindowAttributes(ev.wid, { eventMask: x11.eventMask.PropertyChange });
      await parseWindowToml(ev.wid);
      await parseWindowLighterToml(ev.wid);
    }

    if (ev.name === 'PropertyNotify' && ev.atom === atoms.XINTENT_MATCHBOX_TOML) {
      await parseWindowToml(ev.wid);
    }

    if (ev.name === 'PropertyNotify' && ev.atom === atoms.XINTENT_SERVICES_MANIFEST) {
      await parseWindowLighterToml(ev.wid);
    }

    if (ev.name === 'DestroyNotify') {
      xintentUnregisterWindow(ev.wid);
      xblobUnlinkWindow(ev.wid);
      xaudioUnregisterWindow(ev.wid);
    }

    if (ev.name === 'SelectionClear' && ev.selection === atoms.XINTENT) {
      console.warn('Lost XINTENT selection ownership to another router. Exiting...');
      process.exit(0);
    }
  });
  console.log('[intent-router] Listening for direct window IPC...');
}

startRouter().catch(console.error);