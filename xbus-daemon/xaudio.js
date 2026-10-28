// xaudio.js for xbus-daemon
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xaudio' });
const xintent = require('../x11-promises/xintent.js');
const daemon = require('./index.js');
const xchannel = require('./xchannel');
const registry = require('./xintent-registry');

async function findXAudioSinkWindow() {
  if (xintent.atoms.SESSION_SPEAKERS) {
    try {
      const speakersOwner = await daemon.X.GetSelectionOwner(xintent.atoms.SESSION_SPEAKERS);
      if (speakersOwner) return speakersOwner;
    } catch (_) {}
  }
  const lighterEntries = registry.lighterAudioRegistry ? Object.values(registry.lighterAudioRegistry) : [];
  if (lighterEntries[0]?.wid) {
    return lighterEntries[0].wid;
  }
  for (const [widStr, matchboxToml] of Object.entries(registry.windowRegistry || {})) {
    if (matchboxToml && matchboxToml.XAudioSink) {
      return parseInt(widStr, 10);
    }
  }
  return null;
}

const handleXAudioGetAudioOutputsV0 = {
  parse: async (ev) => xintent.parseXIntentIntentV0(daemon.X, daemon.routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XAudio.GetAudioOutputs',
  }),
  accept: async (parsed) => {
    const outputs = [];
    for (const [pkgName, entry] of Object.entries(registry.lighterAudioRegistry)) {
      if (entry.pkg && entry.pkg.XAudioSink) {
        outputs.push({ package: pkgName, sink: entry.pkg.XAudioSink, wid: xintent.widString(entry.wid) });
      }
    }
    for (const [widStr, matchboxToml] of Object.entries(registry.windowRegistry)) {
      if (matchboxToml && matchboxToml.XAudioSink) {
        outputs.push({
          app: matchboxToml.app?.id || `win-${widStr}`,
          sink: matchboxToml.XAudioSink,
          wid: xintent.widString(parseInt(widStr, 10)),
        });
      }
    }
    logger.info(`XAudioGetAudioOutputs returned ${outputs.length} outputs`);
    if (parsed.channel || parsed.senderWin) {
      await xintent.sendXIntentEventV0(daemon.X, daemon.routerWin, {
        targetWin: parsed.senderWin,
        senderWin: daemon.routerWin,
        channel: parsed.channel,
        controlWord: 3,
        payload: {
          event: 'xaudio.GetAudioOutputsResponse',
          outputs,
          disposition: 'final',
        },
      });
    }
  },
};

const handleXAudioPlayV0 = {
  parse: async (ev) => xintent.parseXIntentIntentV0(daemon.X, daemon.routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XAudio.Play',
  }),
  accept: async (parsed) => {
    const { senderWin, channel, controlWord = 1, payload, payloadBlob, dataBlob } = parsed;
    const isSyn = (controlWord & 1) !== 0;

    let channelObj = xchannel.getChannelForMessage(parsed);
    if (isSyn && !channelObj) {
      channelObj = xchannel.newChannel(senderWin, channel, parsed);
    }

    const sinkWin = await findXAudioSinkWindow();
    if (!sinkWin) {
      logger.error(`XAudioPlay: No active XAudioSink window found for sender ${xintent.widString(senderWin)}`);
      return;
    }

    if (channelObj) {
      channelObj.handlerWin = sinkWin;
    }

    logger.info(`[xaudio] Routing ${xintent.frameDesc(parsed)} to sink window ${xintent.widString(sinkWin)} (dataBlob: ${xintent.widString(dataBlob)})`);

    const dispatchFn = xintent.sendXAudioPlayV0 || xintent.sendXIntentIntentV0;
    await dispatchFn(daemon.X, daemon.routerWin, {
      targetWin: sinkWin,
      senderWin: daemon.routerWin,
      controlWord,
      ...xchannel.getChannelToSend(sinkWin, channelObj),
      payload,
      payloadBlob,
      dataBlob,
    });
  },
};

const handleXAudioControlV0 = {
  parse: async (ev) => xintent.parseXIntentIntentV0(daemon.X, daemon.routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XAudio.Control',
  }),
  accept: async (parsed) => {
    const { controlWord = 1, payload, payloadBlob, dataBlob } = parsed;

    const channelObj = xchannel.getChannelForMessage(parsed);
    const sinkWin = (channelObj && channelObj.handlerWin) ? channelObj.handlerWin : await findXAudioSinkWindow();

    if (sinkWin) {
      logger.info(`[xaudio] Routing ${xintent.frameDesc(parsed)} to sink window ${xintent.widString(sinkWin)}`);
      const dispatchFn = xintent.sendXAudioControlV0 || xintent.sendXIntentIntentV0;
      await dispatchFn(daemon.X, daemon.routerWin, {
        targetWin: sinkWin,
        senderWin: daemon.routerWin,
        controlWord,
        ...xchannel.getChannelToSend(sinkWin, channelObj),
        payload,
        payloadBlob,
        dataBlob,
      });
    }
  },
};

const xaudioUnregisterWindow = (destroyedWin) => {
  for (const channelObj of Object.values(xchannel.activeChannels)) {
    if (channelObj.senderWin === destroyedWin || channelObj.handlerWin === destroyedWin) {
      logger.info(`xaudioUnregisterWindow: closing channel ${channelObj.channelNum} for destroyed window ${xintent.widString(destroyedWin)}`);
      xchannel.closeChannel(channelObj);
    }
  }
};

module.exports = {
  handleXAudioGetAudioOutputsV0,
  handleXAudioPlayV0,
  handleXAudioControlV0,
  xaudioUnregisterWindow,
};
