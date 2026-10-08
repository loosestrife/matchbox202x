// xaudio.js
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xaudio' });
const { atoms, widString, parseXIntentIntentV0, sendXIntentIntentV0, sendXIntentEventV0 } = require('../x11-promises/xintent.js');
const { X, root, routerWin } = require('./index.js');
const { activeChannels, newChannel, closeChannel, getChannel, getChannelToSend, getChannelForMessage } = require('./xchannel');
const { lighterAudioRegistry, windowRegistry } = require('./xintent-registry');

function findXAudioSinkWindow() {
  const lighterEntry = Object.values(lighterAudioRegistry)[0];
  if (lighterEntry && lighterEntry.wid) {
    return lighterEntry.wid;
  }
  for (const [widStr, matchboxToml] of Object.entries(windowRegistry)) {
    if (matchboxToml && matchboxToml.XAudioSink) {
      return parseInt(widStr, 10);
    }
  }
  return null;
}

const handleXAudioGetAudioOutputsV0 = {
  parse: async (ev) => parseXIntentIntentV0(X, routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XAudio.GetAudioOutputs',
  }),
  accept: async (parsed) => {
    const outputs = [];
    for (const [pkgName, entry] of Object.entries(lighterAudioRegistry)) {
      if (entry.pkg && entry.pkg.XAudioSink) {
        outputs.push({ package: pkgName, sink: entry.pkg.XAudioSink, wid: widString(entry.wid) });
      }
    }
    for (const [widStr, matchboxToml] of Object.entries(windowRegistry)) {
      if (matchboxToml && matchboxToml.XAudioSink) {
        outputs.push({ app: matchboxToml.app?.id || `win-${widStr}`, sink: matchboxToml.XAudioSink, wid: widString(parseInt(widStr, 10)) });
      }
    }
    logger.info(`XAudioGetAudioOutputs returned ${outputs.length} outputs`);
    if (parsed.channel || parsed.senderWin) {
      await sendXIntentEventV0(X, routerWin, {
        targetWin: parsed.senderWin,
        senderWin: routerWin,
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
  parse: async (ev) => parseXIntentIntentV0(X, routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XAudio.Play',
  }),
  accept: async (parsed) => {
    const { senderWin, channel, controlWord = 3, payload, payloadBlob, dataBlob } = parsed;
    const isSyn = (controlWord & 1) !== 0;
    const isFin = (controlWord & 2) !== 0;

    let channelObj = getChannelForMessage(parsed);
    if (isSyn && !channelObj) {
      channelObj = newChannel(senderWin, channel, parsed);
    }

    const sinkWin = findXAudioSinkWindow();
    if (!sinkWin) {
      logger.error(`XAudioPlay: No active XAudioSink window found for sender ${widString(senderWin)}`);
      return;
    }

    if (channelObj) {
      channelObj.handlerWin = sinkWin;
    }

    logger.info(`[xaudio] Routing XAudioPlay to sink window ${widString(sinkWin)} (ctrl: ${controlWord}, dataBlob: ${widString(dataBlob)})`);

    await sendXIntentIntentV0(X, routerWin, {
      targetWin: sinkWin,
      senderWin: routerWin,
      controlWord,
      ...getChannelToSend(sinkWin, channelObj),
      payload,
      payloadBlob,
      dataBlob,
    });

    if (isFin && channelObj) {
      closeChannel(channelObj);
    }
  },
};

const handleXAudioControlV0 = {
  parse: async (ev) => parseXIntentIntentV0(X, routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XAudio.Control',
  }),
  accept: async (parsed) => {
    const { senderWin, channel, controlWord = 3, payload, payloadBlob, dataBlob } = parsed;
    const isFin = (controlWord & 2) !== 0;

    let channelObj = getChannelForMessage(parsed);
    const sinkWin = (channelObj && channelObj.handlerWin) ? channelObj.handlerWin : findXAudioSinkWindow();

    if (sinkWin) {
      logger.info(`[xaudio] Routing XAudioControl to sink window ${widString(sinkWin)} (ctrl: ${controlWord})`);
      await sendXIntentIntentV0(X, routerWin, {
        targetWin: sinkWin,
        senderWin: routerWin,
        controlWord,
        ...getChannelToSend(sinkWin, channelObj),
        payload,
        payloadBlob,
        dataBlob,
      });
    }

    if (isFin && channelObj) {
      closeChannel(channelObj);
    }
  },
};

const xaudioUnregisterWindow = (destroyedWin) => {
  for (const channelObj of Object.values(activeChannels)) {
    if (channelObj.senderWin === destroyedWin || channelObj.handlerWin === destroyedWin) {
      logger.info(`xaudioUnregisterWindow: closing channel ${channelObj.channelNum} for destroyed window ${widString(destroyedWin)}`);
      closeChannel(channelObj);
    }
  }
};

module.exports = {
  handleXAudioGetAudioOutputsV0,
  handleXAudioPlayV0,
  handleXAudioControlV0,
  xaudioUnregisterWindow,
};
