// xintent-router.js for xbus-daemon

const { exec } = require("child_process");
const crypto = require("crypto");
const TOML = require("@iarna/toml");
const util = require("util");
const execAsync = util.promisify(exec);
const {Logger} = require('../server-tools');
const logger = new Logger({module: 'xintent-router'});
const {
  atoms,
  widString,
  frameType,
  frameDesc,
  parseXIntentIntentV0,
  parseXIntentEventV0,
  XClientMessage,
  sendXIntentEventV0,
  sendXAudioPlayResponseV0,
  sendXChannelJsonFrame,
  XBlobWrite,
} = require("../x11-promises/xintent");
const { x11, X, root, routerWin } = require("./index");
const {
  implicitXBlobGrant,
  implicitXBlobTransfer,
  xblobCreate,
  xblobUnlink,
} = require("./xblob");

const {activeChannels, txidToChannel, newChannel, createVirtualChannel, closeChannel, getChannel, getChannelToSend, getChannelForMessage} = require('./xchannel');
const {
  intentRegistry,
  lighterRegistry,
  windowRegistry,
  lighterAudioRegistry,
  getAllMatchboxToml,
  parseWindowToml,
  parseWindowLighterToml,
  updateAggregateToml,
  unregisterWindowRegistry,
  initXIntentRegistry,
} = require('./xintent-registry');
const { evaluateRoutePolicy } = require('./xintent-policy');
const { cleanupDestroyedWindow } = require('./xintent-cleanup');

const intentsAwaitingServicesQueue = {}; // intent -> [xchannelFrame]
async function checkToDrainIntentsQueue(intentName) {
  const queue = intentsAwaitingServicesQueue[intentName];
  while (queue && queue.length) {
    tryToForwardTheFrame(queue.shift());
  }
}
initXIntentRegistry({checkToDrainIntentsQueue});

function formatActionString(xchannelFrame, ev) {
  return frameType(xchannelFrame || ev);
}

const handleXIntentIntentV0 = {
  parse: async (ev) => parseXIntentIntentV0(X, routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (xchannelFrame, ev) => {
    return {
      source: { window: xchannelFrame.senderWin },
      action: formatActionString(xchannelFrame, ev),
      resources: [],
    };
  },
  accept: async (xchannelFrame) => {
    await tryToForwardTheFrame(xchannelFrame);
  },
};

const handleForwardingOfXChannelJsonFrame = {
  parse: async (ev) => parseXIntentEventV0(X, routerWin, ev, { unlinkPayloadBlob: false }),
  securityContext: (xchannelFrame, ev) => {
    return {
      source: { window: xchannelFrame.senderWin },
      action: formatActionString(xchannelFrame, ev),
    };
  },
  accept: async (xchannelFrame) => {
    await tryToForwardTheFrame(xchannelFrame);
  }
};
const handleXIntentEventV0 = handleForwardingOfXChannelJsonFrame;

const tryToForwardTheFrame = async (xchannelFrame) => {
  const { senderWin, channel, payload } = xchannelFrame;
  const actionStr = formatActionString(xchannelFrame);

  let parsedPayload = payload;
  if (typeof payload === "string") {
    try {
      parsedPayload = JSON.parse(payload);
    } catch (_) {
      parsedPayload = payload;
    }
  }

  const intent = parsedPayload?.intent || parsedPayload?.event || parsedPayload?.action || (parsedPayload?.data && typeof parsedPayload.data === 'object' ? (parsedPayload.data.intent || parsedPayload.data.event || parsedPayload.data.action) : undefined);

  let channelObj = getChannelForMessage(xchannelFrame);
  if (channelObj) {
    if (await forwardMessageToChannel(channelObj, xchannelFrame)) {
      return;
    }
  }

  const controlWord = xchannelFrame.controlWord ?? 3;
  const isSyn = (controlWord & 1) !== 0;

  if (isSyn) {
    channelObj = getChannel(senderWin, channel);
    if (!channelObj) {
      channelObj = newChannel(senderWin, channel, xchannelFrame);
    }
  }

  if (!channelObj && intent) {
    channelObj = createVirtualChannel(senderWin, xchannelFrame);
  }

  if (intent) {
    const policyResult = await evaluateRoutePolicy({
      xchannelFrame,
      intent,
      parsedPayload,
      intentRegistry,
      windowRegistry,
      lighterRegistry,
      intentsAwaitingServicesQueue,
      sendXIntentIntentV0,
      X,
      routerWin,
      formatActionString,
    });

    if (policyResult.status === 'rejected' || policyResult.status === 'launching') {
      return;
    }

    if (policyResult.status === 'matched') {
      const { selectedEntry, targetAppId } = policyResult;
      const { wid } = selectedEntry;
      logger.info(`[intent-router] Found service window (${widString(wid)}) for ${actionStr} (target app: ${targetAppId || 'any'})`);
      if (channelObj) {
        channelObj.handlerWin = wid;
      }
      await sendXIntentIntentV0(X, routerWin, {
        targetWin: wid,
        senderWin: routerWin,
        ...getChannelToSend(wid, channelObj),
        payload: xchannelFrame.payload,
        payloadBlob: xchannelFrame.payloadBlob,
        dataBlob: xchannelFrame.dataBlob,
      });

      if (channelObj && channelObj.isVirtual) {
        logger.info(`Passed on message for ${channelObj.virtualSender}. Deleting transient virtual channel 0.`);
        channelObj = null;
      }
      return;
    }
  } else {
    logger.info(`dropping xchannel frame without active channel ${actionStr}`, xchannelFrame);
  }
};

const forwardMessageToChannel = async (channelObj, message) => {
  const actionStr = formatActionString(message);
  if (channelObj) {
    if (channelObj.handlerWin) {
      let forwardTo;
      if (message.senderWin == channelObj.handlerWin) {
        // usual case: handler replying back to sender
        forwardTo = channelObj.senderWin;
      } else if (message.senderWin == channelObj.senderWin) {
        // for example sys.Cancel or stream chunk from sender
        forwardTo = channelObj.handlerWin;
      } else {
        logger.info(
          `Message ${actionStr} in channel ${message.channel} was sent by ${widString(message.senderWin)} not on channel (was the intent redirected?)`,
          message,
          channelObj,
        );
        return true;
      }
      const controlWord = message.controlWord ?? 3;
      const isFin = (controlWord & 2) !== 0;
      const dataBlob = message.dataBlob || message.payload?.data_blob || message.payload?.blobId || message.payload?.blob || 0;

      const sendFn = message.messageTypeAtom === atoms.XAUDIO_PLAY_RESPONSE_V0
        ? sendXAudioPlayResponseV0
        : (message.messageTypeAtom === atoms.XINTENT_EVENT_V0 ? sendXIntentEventV0 : sendXChannelJsonFrame);

      await sendFn(X, routerWin, {
        targetWin: forwardTo,
        senderWin: routerWin,
        controlWord: controlWord,
        ...getChannelToSend(forwardTo, channelObj),
        payload: message.payload,
        payloadBlob: message.payloadBlob,
        dataBlob: dataBlob,
      });

      if (isFin) {
        closeChannel(channelObj);
      }
      return true;
    } else {
      return false;
    }
  }
};

async function sendXIntentIntentV0(
  X,
  routerWin,
  { targetWin, senderWin, txId, channel, controlWord, payload, payloadBlob, dataBlob },
) {
  if (!payloadBlob) {
    payloadBlob = await xblobCreate(routerWin);
    await XBlobWrite(X, routerWin, routerWin, payloadBlob, payload);
  }
  implicitXBlobTransfer(payloadBlob, routerWin, targetWin);
  if (dataBlob) {
    implicitXBlobTransfer(dataBlob, routerWin, targetWin);
  }

  const channelToSend = (channel !== undefined && channel !== 0) ? (channel >>> 0) : (txId !== undefined ? (txId >>> 0) : 0);
  const ctrlWordToSend = (controlWord !== undefined ? controlWord : 0) >>> 0;

  await XClientMessage(X, targetWin, atoms.XINTENT_INTENT_V0, [
    (senderWin || routerWin) >>> 0,
    channelToSend,
    ctrlWordToSend,
    (payloadBlob >>> 0),
    (dataBlob || 0) >>> 0,
  ]);
  logger.info(
    `Dispatched ${payload?.intent || payload?.event} to ${widString(targetWin)} (channel ${channelToSend}, ctrl ${ctrlWordToSend}, payload blob ${widString(payloadBlob)})`,
  );
  return payloadBlob;
}

const xintentUnregisterWindow = async (destroyedWin) => {
  await cleanupDestroyedWindow({
    destroyedWin,
    intentRegistry,
    lighterRegistry,
    windowRegistry,
    lighterAudioRegistry,
    intentsAwaitingServicesQueue,
    activeChannels,
    unregisterWindowRegistry,
    updateAggregateToml,
    sendXIntentIntentV0,
    getChannelToSend,
    closeChannel,
    tryToForwardTheFrame,
    X,
    routerWin,
  });
};

module.exports = {
  handleXIntentIntentV0,
  handleXIntentEventV0,
  handleForwardingOfXChannelJsonFrame,
  getAllMatchboxToml,
  parseWindowToml,
  parseWindowLighterToml,
  xintentUnregisterWindow,
};
