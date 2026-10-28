// xintent-router.js for xbus-daemon
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xintent-router' });
const xintent = require('../x11-promises/xintent');
const daemon = require('./index');
const xblob = require('./xblob');
const xchannel = require('./xchannel');
const registry = require('./xintent-registry');
const { evaluateRoutePolicy } = require('./xintent-policy');
const { cleanupDestroyedWindow } = require('./xintent-cleanup');

const intentsAwaitingServicesQueue = {}; // intent -> [xchannelFrame]
async function checkToDrainIntentsQueue(intentName) {
  const queue = intentsAwaitingServicesQueue[intentName];
  while (queue && queue.length) {
    tryToForwardTheFrame(queue.shift());
  }
}
registry.initXIntentRegistry({ checkToDrainIntentsQueue });

function formatActionString(xchannelFrame, ev) {
  return xintent.frameType(xchannelFrame || ev);
}

const handleXIntentIntentV0 = {
  parse: async (ev) => xintent.parseXIntentIntentV0(daemon.X, daemon.routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (xchannelFrame, ev) => ({
    source: { window: xchannelFrame.senderWin },
    action: formatActionString(xchannelFrame, ev),
    resources: [],
  }),
  accept: async (xchannelFrame) => {
    await tryToForwardTheFrame(xchannelFrame);
  },
};

const handleForwardingOfXChannelJsonFrame = {
  parse: async (ev) => xintent.parseXIntentEventV0(daemon.X, daemon.routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (xchannelFrame, ev) => ({
    source: { window: xchannelFrame.senderWin },
    action: formatActionString(xchannelFrame, ev),
  }),
  accept: async (xchannelFrame) => {
    await tryToForwardTheFrame(xchannelFrame);
  },
};
const handleXIntentEventV0 = handleForwardingOfXChannelJsonFrame;

function parseFramePayloadAndIntent(payload) {
  let parsedPayload = payload;
  if (typeof payload === 'string') {
    try {
      parsedPayload = JSON.parse(payload);
    } catch (_) {
      parsedPayload = payload;
    }
  }
  const direct = parsedPayload?.intent || parsedPayload?.event || parsedPayload?.action;
  const nested = (parsedPayload?.data && typeof parsedPayload.data === 'object')
    ? (parsedPayload.data.intent || parsedPayload.data.event || parsedPayload.data.action)
    : undefined;
  return { parsedPayload, intent: direct || nested };
}

function resolveOrCreateFrameChannel(xchannelFrame, intent) {
  const { senderWin, channel } = xchannelFrame;
  const controlWord = xchannelFrame.controlWord ?? 3;
  const isSyn = (controlWord & 1) !== 0;

  let channelObj = isSyn ? (xchannel.getChannel(senderWin, channel) || xchannel.newChannel(senderWin, channel, xchannelFrame)) : null;
  if (!channelObj && intent) {
    channelObj = xchannel.createVirtualChannel(senderWin, xchannelFrame);
  }
  return channelObj;
}

async function dispatchMatchedIntent(policyResult, xchannelFrame, channelObj, actionStr) {
  const { selectedEntry, targetAppId } = policyResult;
  const { wid } = selectedEntry;
  logger.info(`[intent-router] Found service window (${xintent.widString(wid)}) for ${actionStr} (target app: ${targetAppId || 'any'})`);
  if (channelObj) {
    channelObj.handlerWin = wid;
  }
  await sendXIntentIntentV0(daemon.X, daemon.routerWin, {
    targetWin: wid,
    senderWin: daemon.routerWin,
    ...xchannel.getChannelToSend(wid, channelObj),
    payload: xchannelFrame.payload,
    payloadBlob: xchannelFrame.payloadBlob,
    dataBlob: xchannelFrame.dataBlob,
  });

  if (channelObj && channelObj.isVirtual) {
    logger.info(`Passed on message for ${channelObj.virtualSender}. Deleting transient virtual channel 0.`);
  }
}

const tryToForwardTheFrame = async (xchannelFrame) => {
  const actionStr = formatActionString(xchannelFrame);
  const existingChannel = xchannel.getChannelForMessage(xchannelFrame);
  if (existingChannel && (await forwardMessageToChannel(existingChannel, xchannelFrame))) {
    return;
  }

  const { parsedPayload, intent } = parseFramePayloadAndIntent(xchannelFrame.payload);
  const channelObj = resolveOrCreateFrameChannel(xchannelFrame, intent);
  if (!intent) {
    logger.info(`dropping xchannel frame without active channel ${actionStr}`, xchannelFrame);
    return;
  }

  const policyResult = await evaluateRoutePolicy({
    xchannelFrame,
    intent,
    parsedPayload,
    intentRegistry: registry.intentRegistry,
    windowRegistry: registry.windowRegistry,
    lighterRegistry: registry.lighterRegistry,
    intentsAwaitingServicesQueue,
    sendXIntentIntentV0,
    X: daemon.X,
    routerWin: daemon.routerWin,
    formatActionString,
  });

  if (policyResult.status === 'matched') {
    await dispatchMatchedIntent(policyResult, xchannelFrame, channelObj, actionStr);
  }
};

function selectChannelSendFn(messageTypeAtom) {
  if (messageTypeAtom === xintent.atoms.XAUDIO_PLAY_RESPONSE_V0) {
    return xintent.sendXAudioPlayResponseV0;
  }
  if (messageTypeAtom === xintent.atoms.XINTENT_EVENT_V0) {
    return xintent.sendXIntentEventV0;
  }
  return xintent.sendXChannelJsonFrame;
}

const forwardMessageToChannel = async (channelObj, message) => {
  if (!channelObj || !channelObj.handlerWin) return false;

  const actionStr = formatActionString(message);
  let forwardTo = null;
  if (message.senderWin == channelObj.handlerWin) {
    forwardTo = channelObj.senderWin;
  } else if (message.senderWin == channelObj.senderWin) {
    forwardTo = channelObj.handlerWin;
  } else {
    logger.info(
      `Message ${actionStr} in channel ${message.channel} was sent by ${xintent.widString(message.senderWin)} not on channel (was the intent redirected?)`,
      message,
      channelObj,
    );
    return true;
  }

  const controlWord = message.controlWord ?? 3;
  const dataBlob = message.dataBlob || message.payload?.data_blob || message.payload?.blobId || message.payload?.blob || 0;
  const sendFn = selectChannelSendFn(message.messageTypeAtom);

  await sendFn(daemon.X, daemon.routerWin, {
    targetWin: forwardTo,
    senderWin: daemon.routerWin,
    controlWord,
    ...xchannel.getChannelToSend(forwardTo, channelObj),
    payload: message.payload,
    payloadBlob: message.payloadBlob,
    dataBlob,
  });

  if ((controlWord & 2) !== 0) {
    xchannel.closeChannel(channelObj);
  }
  return true;
};

async function sendXIntentIntentV0(
  X,
  routerWin,
  { targetWin, senderWin, txId, channel, controlWord, payload, payloadBlob, dataBlob },
) {
  if (!payloadBlob) {
    payloadBlob = await xblob.xblobCreate(routerWin);
    await xintent.XBlobWrite(X, routerWin, routerWin, payloadBlob, payload);
  }
  xblob.implicitXBlobTransfer(payloadBlob, routerWin, targetWin);
  if (dataBlob) {
    xblob.implicitXBlobTransfer(dataBlob, routerWin, targetWin);
  }

  const channelToSend = (channel !== undefined && channel !== 0) ? (channel >>> 0) : (txId !== undefined ? (txId >>> 0) : 0);
  const ctrlWordToSend = (controlWord !== undefined ? controlWord : 0) >>> 0;

  await xintent.XClientMessage(X, targetWin, xintent.atoms.XINTENT_INTENT_V0, [
    (senderWin || routerWin) >>> 0,
    channelToSend,
    ctrlWordToSend,
    payloadBlob >>> 0,
    (dataBlob || 0) >>> 0,
  ]);
  logger.info(
    `Dispatched ${payload?.intent || payload?.event} to ${xintent.widString(targetWin)} (channel ${channelToSend}, ctrl ${ctrlWordToSend}, payload blob ${xintent.widString(payloadBlob)})`,
  );
  return payloadBlob;
}

const xintentUnregisterWindow = async (destroyedWin) => {
  await cleanupDestroyedWindow({
    destroyedWin,
    intentRegistry: registry.intentRegistry,
    lighterRegistry: registry.lighterRegistry,
    windowRegistry: registry.windowRegistry,
    lighterAudioRegistry: registry.lighterAudioRegistry,
    intentsAwaitingServicesQueue,
    activeChannels: xchannel.activeChannels,
    unregisterWindowRegistry: registry.unregisterWindowRegistry,
    updateAggregateToml: registry.updateAggregateToml,
    sendXIntentIntentV0,
    getChannelToSend: xchannel.getChannelToSend,
    closeChannel: xchannel.closeChannel,
    tryToForwardTheFrame,
    X: daemon.X,
    routerWin: daemon.routerWin,
  });
};

module.exports = {
  handleXIntentIntentV0,
  handleXIntentEventV0,
  handleForwardingOfXChannelJsonFrame,
  getAllMatchboxToml: registry.getAllMatchboxToml,
  parseWindowToml: registry.parseWindowToml,
  parseWindowLighterToml: registry.parseWindowLighterToml,
  xintentUnregisterWindow,
};
