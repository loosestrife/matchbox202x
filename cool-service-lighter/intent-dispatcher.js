// intent-dispatcher.js for cool-service-lighter
const { spawn } = require('child_process');
const xintent = require('../x11-promises/xintent');
const { Logger, alStorage } = require('../server-tools');
const logger = new Logger({ module: 'intent-dispatcher' });

function extractIntentName(payload) {
  if (!payload) return undefined;
  const direct = payload.intent || payload.action || payload.event;
  if (direct) return direct;
  if (payload.data && typeof payload.data === 'object') {
    return payload.data.intent || payload.data.action || payload.data.event;
  }
  return undefined;
}

function handleSysLaunch(xintentIntent, { packageRegistry, trackChild }) {
  const payload = xintentIntent.payload;
  const pakName = payload.package || payload.data?.package;
  const pkg = packageRegistry[pakName];
  const intendedIntent = payload.intendedIntent || payload.data?.intendedIntent;
  const intent = pkg ? pkg.intents[intendedIntent] : undefined;
  logger.setContext({ package: pakName, intendedIntent });
  logger.info(`Got request to load ${pakName} for ${intendedIntent}`, intent);

  const proc = spawn(intent.exec, { shell: true, cwd: pkg._path || process.cwd(), stdio: 'inherit' });
  trackChild(proc);
  proc.on('error', (err) => {
    logger.error('Failed to launch service:', err);
  });
}

function registerAliases(map, names, fn) {
  for (const name of names) {
    map[name] = fn;
  }
}

const INTENT_DISPATCH_TABLE = (() => {
  const table = {
    'sys.Launch': (frame, ctx) => handleSysLaunch(frame, ctx),
    'fs.PickFilePath': (frame, ctx) => ctx.pickFiles.pickFilePath(frame),
    'fs.PickFile': (frame, ctx) => ctx.pickFiles.pickFile(frame),
  };
  registerAliases(
    table,
    ['xaudio.PlaySoundBlob', 'XAudioPlaySoundBlob', 'XAudioPlaySoundBlobV0', 'XAudioPlayV0', 'XAudioPlay', 'xaudio.Play'],
    (frame, ctx) => ctx.xaudioNode.playSoundBlob(frame.payload, frame.senderWin, frame.dataBlob, frame.channel)
  );
  registerAliases(
    table,
    ['xaudio.PrefetchSoundBlob', 'XAudioPrefetchSoundBlob', 'XAudioPrefetchSoundBlobV0', 'XAudioPrefetch'],
    (frame, ctx) => ctx.xaudioNode.prefetchSoundBlob(frame.payload, frame.dataBlob)
  );
  registerAliases(
    table,
    ['xaudio.PlayStream', 'PlayStream', 'XAudioPlayStreamV0'],
    (frame, ctx) => ctx.xaudioNode.playStream(frame.payload, frame.senderWin, frame.dataBlob, frame.channel)
  );
  registerAliases(
    table,
    ['xaudio.ControlStream', 'ControlStream', 'XAudioControlStreamV0', 'XAudioControlV0', 'XAudioControl', 'xaudio.Control'],
    (frame, ctx) => ctx.xaudioNode.controlStream(frame.payload, frame.channel, frame.controlWord)
  );
  registerAliases(
    table,
    ['xaudio.SeekStream', 'SeekStream', 'XAudioSeekStreamV0', 'XAudioSeekV0'],
    (frame, ctx) => ctx.xaudioNode.seekStream(frame.payload)
  );
  return table;
})();

async function handleIntentOrEventFrame(ctx) {
  const { X, ev } = ctx;
  const xintentIntent = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
  const intentName = extractIntentName(xintentIntent.payload);
  logger.setContext({
    intent: intentName,
    sender: xintent.widString(xintentIntent.senderWin),
    channel: xintentIntent.channel,
  });

  const handler = INTENT_DISPATCH_TABLE[intentName];
  if (!handler) {
    logger.warn('unknown intent', intentName);
    return;
  }
  await handler(xintentIntent, ctx);
}

function createXAudioAtomHandler(intentLabel, invokeFn) {
  return async (ctx) => {
    const parsed = await xintent.parseXIntentIntentV0(ctx.X, xintent.routerWin, ctx.ev, { unlinkPayloadBlob: false });
    logger.setContext({ intent: intentLabel });
    await invokeFn(parsed, ctx.xaudioNode);
  };
}

function buildAtomDispatchMap(atoms) {
  const noop = async () => {};
  return new Map([
    [atoms.xintentIntentV0Atom, handleIntentOrEventFrame],
    [atoms.xintentEventV0Atom, handleIntentOrEventFrame],
    [atoms.xaudioPlaySoundBlobAtom, createXAudioAtomHandler('xaudio.Play', (p, node) => node.playSoundBlob(p.payload, p.senderWin, p.dataBlob, p.channel))],
    [atoms.xaudioPrefetchSoundBlobAtom, createXAudioAtomHandler('xaudio.PrefetchSoundBlob', (p, node) => node.prefetchSoundBlob(p.payload))],
    [atoms.xaudioPlayStreamAtom, createXAudioAtomHandler('xaudio.PlayStream', (p, node) => node.playStream(p.payload, p.senderWin))],
    [atoms.xaudioControlStreamAtom, createXAudioAtomHandler('xaudio.ControlStream', (p, node) => node.controlStream(p.payload, p.channel, p.controlWord))],
    [atoms.xaudioSeekStreamAtom, createXAudioAtomHandler('xaudio.SeekStream', (p, node) => node.seekStream(p.payload))],
    [atoms.xblobBroadcastAtom, async (ctx) => {
      const frame = xintent.parseXBlobBroadcastFrame(ctx.X, xintent.routerWin, ctx.ev);
      logger.setContext({ event: 'XBLOB_BROADCAST', blob: xintent.widString(frame.blob) });
      await ctx.pickFiles.xblobBroadcast(frame);
    }],
    [atoms.xblobDestructorAtom, async (ctx) => {
      const frame = xintent.parseXBlobDestructorFrame(ctx.X, xintent.routerWin, ctx.ev);
      logger.setContext({ event: 'XBLOB_DESTRUCTOR', blob: xintent.widString(frame.blob) });
      await ctx.pickFiles.xblobDestructor(frame);
    }],
    [atoms.xblobCreateResponseAtom, noop],
    [atoms.xblobStreamClosedAtom, noop],
    [atoms.xintentDataAtom, noop],
  ]);
}

async function handleClientMessageEvent(ctx) {
  const { ev, lighterWin, atoms } = ctx;
  const isClientMessage = ev.type === 33 || ev.name === 'ClientMessage';
  if (!isClientMessage || ev.wid !== lighterWin) return;

  alStorage.run(
    {
      values: { msgType: ev.message_type, seq: ev.seq },
      timers: { start: new Date() },
    },
    async () => {
      try {
        const atomMap = buildAtomDispatchMap(atoms);
        const handler = atomMap.get(ev.message_type);
        if (!handler) {
          logger.error(`got unknown message type atom ${ev.message_type}`);
          return;
        }
        await handler(ctx);
      } catch (err) {
        logger.error('Error processing ClientMessage event:', err);
      }
    }
  );
}

module.exports = {
  handleClientMessageEvent,
};
