// xintent-router.js

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
  parseXIntentIntentV0,
  parseXIntentEventV0,
  XClientMessage,
} = require("../x11-promises/xintent");
const { x11, X, root, routerWin } = require("./index");
const {
  implicitXBlobGrant,
  implicitXBlobTransfer,
  xblobCreate,
  xblobUnlink,
} = require("./xblob");

const {activeChannels, txidToChannel, newChannel, closeChannel, getChannel, getChannelToSend, getChannelForMessage} = require('./xchannel');
const {
  intentRegistry,
  lighterRegistry,
  getAllMatchboxToml,
  parseWindowToml,
  parseWindowLighterToml,
  updateAggregateToml,
  unregisterWindowRegistry,
  initXIntentRegistry,
} = require('./xintent-registry');

const intentsAwaitingServicesQueue = {}; // intent -> [xintentIntent]
async function checkToDrainIntentsQueue(intentName) {
  const queue = intentsAwaitingServicesQueue[intentName];
  while (queue && queue.length) {
    tryToForwardTheIntent(queue.shift());
  }
}
initXIntentRegistry({checkToDrainIntentsQueue});

const handleXIntentIntentV0 = {
  parse: async (ev) => parseXIntentIntentV0(X, routerWin, ev, {unlinkPayloadBlob: false}),
  securityContext: (xintentIntent) => {
    return {
      source: { window: xintentIntent.senderWin },
      action: `XIntent.${xintentIntent.payload.intent}`,
      resources: [],
    };
  },
  accept: async (xintentIntent) => {
    await tryToForwardTheIntent(xintentIntent);
  },
};

const handleXIntentEventV0 = {
  parse: async (ev) => parseXIntentEventV0(X, routerWin, ev, {unlinkPayloadBlob: false}),
  securityContext: (xintentEvent) => {
    return {
      source: {window: xintentEvent.senderWin },
      action: `XIntentEvent.${xintentEvent.payload.event}`
    };
  },
  accept: async (xintentEvent) => {
    await tryToForwardTheEvent(xintentEvent);
  }
};

const tryToForwardTheIntent = async (xintentIntent) => {
  const {senderWin, channel, payload} = xintentIntent;
  const intent = payload.intent;

  let channelObj = getChannelForMessage(xintentIntent);
  if(channelObj){
    if(await forwardMessageToChannel(channelObj, xintentIntent)){
      return;
    }
  }

  const controlWord = xintentIntent.controlWord ?? 3;
  const isSyn = (controlWord & 1) !== 0;

  if (isSyn) {
    channelObj = getChannel(senderWin, channel);
    if (!channelObj) {
      channelObj = newChannel(senderWin, channel, xintentIntent);
    }
  }

  // (4) find a handler and send the intent
  const registryEntry = intentRegistry[intent];
  if (registryEntry) {
    const { wid, matchboxToml } = registryEntry[0];
    logger.info(`[intent-router] Found service window (${widString(wid)})`);
    if (channelObj) {
      channelObj.handlerWin = wid;
    }
    await sendXIntentIntentV0(X, routerWin, {
      targetWin: wid,
      senderWin: routerWin,
      ...getChannelToSend(wid, channelObj),
      payload: xintentIntent.payload,
      payloadBlob: xintentIntent.payloadBlob,
      dataBlob: xintentIntent.dataBlob,
    });
    return;
  } else {
    logger.info(
      `[intent-router] No service mapped for action: ${intent}, falling back to lighter ${JSON.stringify(lighterRegistry, null, 2)}`,
    );
    const lighterRegistryEntry = lighterRegistry[intent];
    if (lighterRegistryEntry && lighterRegistryEntry.length > 0) {
      const { computer, packageName, wid, publicKeyHash } =
        lighterRegistryEntry[0];
      await sendXIntentIntentV0(X, routerWin, {
        targetWin: wid,
        senderWin: routerWin,
        txId: 0,
        payload: {
          intent: "sys.Launch",
          computer,
          package: packageName,
          intendedIntent: intent,
        },
      });
    } else {
      logger.error(`no launchable service found for ${intent}`);
    }
    if (!intentsAwaitingServicesQueue[intent]) {
      intentsAwaitingServicesQueue[intent] = [];
    }
    intentsAwaitingServicesQueue[intent].push(xintentIntent);
  }
};

const tryToForwardTheEvent = async (xintentEvent) => {
  let channelObj = getChannelForMessage(xintentEvent);
  if(channelObj){
    if(await forwardMessageToChannel(channelObj, xintentEvent)){
      return;
    }
  }
  logger.info("dropping event that isnt in a channel", xintentEvent);
}


const forwardMessageToChannel = async (channelObj, message) => {
  const messageSubType = message.intent ?? message.event;
  if(channelObj){
    if (channelObj.handlerWin) {
      let forwardTo;
      if (message.senderWin == channelObj.handlerWin) {
        // usual case
        forwardTo = channelObj.senderWin;
      } else if (message.senderWin == channelObj.senderWin) {
        // for example sys.Cancel 
        forwardTo = channelObj.handlerWin;
      } else {
        logger.info(
          `Message ${messageSubType} in channel ${message.channel} was sent by ${widString(message.senderWin)} not on channel (was the intent redirected?)`,
          message,
          channelObj,
        );
        return true;
      }
      const controlWord = message.controlWord ?? 3;
      const isFin = (controlWord & 2) !== 0;
      const dataBlob = message.dataBlob || message.payload?.data_blob || message.payload?.blobId || message.payload?.blob || 0;

      await sendXIntentIntentV0(X, routerWin, {
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
      // the channel object was created, but there is not a handler yet
      // creating the channel object without a handler enables the user to redirect intents
      // thats the only reason this else block should be reachable
      return false;
    }
  }
}




// we need a customized version of this here that doesnt send an XBlobCreate
async function sendXIntentIntentV0(
  X,
  routerWin,
  { targetWin, senderWin, txId, channel, controlWord, payload, payloadBlob, dataBlob },
) {
  if (!payloadBlob) {
    payloadBlob = await xblobCreate(routerWin);
    await X.ChangeProperty(
      0,
      routerWin,
      payloadBlob,
      atoms.STRING,
      8,
      Buffer.from(JSON.stringify(payload, null, 2)),
    );
  }
  implicitXBlobTransfer(payloadBlob, routerWin, targetWin);
  if (dataBlob) {
    implicitXBlobTransfer(dataBlob, routerWin, targetWin);
  }

  const channelToSend = (channel !== undefined && channel !== 0) ? (channel >>> 0) : (txId !== undefined ? (txId >>> 0) : 0);
  const ctrlWordToSend = (controlWord !== undefined
    ? controlWord
    : (channelToSend !== 0 || payload?.reply || payload?.Accept ? 3 : 0)) >>> 0;

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

/**
 * Unregisters a window that has been destroyed, cleaning up registries
 * and handling active channel lifecycles.
 */
const xintentUnregisterWindow = async (destroyedWin) => {
  logger.info(`Unregistering window ${widString(destroyedWin)}`);
  let registryChanged = false;

  // 1. Remove window from intentRegistry
  for (const intentName of Object.keys(intentRegistry)) {
    const originalLen = intentRegistry[intentName].length;
    intentRegistry[intentName] = intentRegistry[intentName].filter(
      (entry) => entry.wid !== destroyedWin
    );
    if (intentRegistry[intentName].length !== originalLen) {
      registryChanged = true;
    }
    if (intentRegistry[intentName].length === 0) {
      delete intentRegistry[intentName];
    }
  }

  // 2. Remove window from lighterRegistry
  for (const intentName of Object.keys(lighterRegistry)) {
    const originalLen = lighterRegistry[intentName].length;
    lighterRegistry[intentName] = lighterRegistry[intentName].filter(
      (entry) => entry.wid !== destroyedWin
    );
    if (lighterRegistry[intentName].length !== originalLen) {
      registryChanged = true;
    }
    if (lighterRegistry[intentName].length === 0) {
      delete lighterRegistry[intentName];
    }
  }

  if (unregisterWindowRegistry(destroyedWin)) {
    registryChanged = true;
  }

  if (registryChanged) {
    await updateAggregateToml();
  }

  // 3. Remove queued intents originating from the destroyed sender
  for (const intentName of Object.keys(intentsAwaitingServicesQueue)) {
    intentsAwaitingServicesQueue[intentName] = intentsAwaitingServicesQueue[intentName].filter(
      (xintent) => !((xintent.senderWin == destroyedWin) && (xintent.payload.Accept)) 
    );
    if (intentsAwaitingServicesQueue[intentName].length === 0) {
      delete intentsAwaitingServicesQueue[intentName];
    }
  }

  // 4. Process active channels
  const retryIntents = [];
  const channels = Object.values(activeChannels);

  for (const channelObj of channels) {
    if (channelObj.senderWin === destroyedWin) {
      // Sender died: notify handler with sys.Cancel and close channel
      if (channelObj.handlerWin && channelObj.handlerWin !== destroyedWin) {
        logger.info(
          `Sender ${widString(destroyedWin)} destroyed; sending sys.Cancel to handler ${widString(channelObj.handlerWin)} on channel ${channelObj.channelNum}`
        );
        await sendXIntentIntentV0(X, routerWin, {
          targetWin: channelObj.handlerWin,
          senderWin: routerWin,
          ...getChannelToSend(channelObj.handlerWin, channelObj),
          payload: {
            intent: "sys.Cancel",
            disposition: "cancel",
            reason: "connection reset by peer",
          },
        });
      }
      closeChannel(channelObj);
    } else if (channelObj.handlerWin === destroyedWin) {
      // Handler died: unbind handler and queue intent for re-forwarding after cleanup
      logger.info(
        `Handler ${widString(destroyedWin)} destroyed on channel ${channelObj.channelNum}; resetting handler`
      );
      channelObj.handlerWin = null;
      if (channelObj.originalIntent) {
        retryIntents.push(channelObj.originalIntent);
      }
    }
  }

  // 5. Re-forward intents whose handlers disappeared (now that registries are clean)
  for (const pendingIntent of retryIntents) {
    logger.info(
      `Re-attempting to forward intent '${pendingIntent.payload?.intent}' after handler cleanup`
    );
    await tryToForwardTheIntent(pendingIntent);
  }
};

module.exports = {
  handleXIntentIntentV0,
  handleXIntentEventV0,
  getAllMatchboxToml,
  parseWindowToml,
  parseWindowLighterToml,
  xintentUnregisterWindow,
};