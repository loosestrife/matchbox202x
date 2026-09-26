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

// ipc isn't just client <- messages -> client its client:port <- channels -> client:port
// WebWorkers lacked ports or channels
// X11 has windows as ports
// XINTENT adds channels for intents
// Channel & Service Registry State
const activeChannels = {};      // channelNum -> channelObj
const txidToChannel = {};       // senderWin -> { [txId]: channelObj }
const intentRegistry = {};      // intent -> [{ wid, matchboxToml }]
const lighterRegistry = {};     // intent -> [{ wid, computer, packageName, publicKeyHash }]
const intentsAwaitingServicesQueue = {}; // intent -> [xintentIntent]

const CHANNEL_BASE = 16777216;  // 0x01000000 (24-bit boundary)
const MAX_UINT32   = 4294967295; // 0xFFFFFFFF

// ---------------------------------------------------------------------------
// Channel Allocation & Lifecycle
// ---------------------------------------------------------------------------

let channelSerialNumberStamp = CHANNEL_BASE;

/**
 * Allocates a new server channel >= 16,777,216 for a client request.
 */
const newChannel = (senderWin, txId, xintentIntent) => {
  let channelNum;
  do {
    channelNum = channelSerialNumberStamp++;
    if (channelSerialNumberStamp > MAX_UINT32) {
      channelSerialNumberStamp = CHANNEL_BASE; // Rollover safely
    }
  } while (activeChannels[channelNum]);

  const channelObj = {
    channelNum,
    senderWin,
    senderCookie: txId, // Original 24-bit client txId
    handlerWin: null,   // Bound once mapped to a service window
    intent: xintentIntent.payload.intent,
    xintentIntent,
  };

  activeChannels[channelNum] = channelObj;

  if (!txidToChannel[senderWin]) {
    txidToChannel[senderWin] = {};
  }
  txidToChannel[senderWin][txId] = channelObj;

  logger.info(`Allocated channel ${channelNum} for client ${widString(senderWin)} (cookie txId: ${txId})`);
  return channelObj;
};

/**
 * Deallocates and purges an active channel from router memory.
 */
const closeChannel = (channelObj) => {
  if (!channelObj) return;

  delete activeChannels[channelObj.channelNum];

  const clientMap = txidToChannel[channelObj.senderWin];
  if (clientMap) {
    delete clientMap[channelObj.senderCookie];
    if (Object.keys(clientMap).length === 0) {
      delete txidToChannel[channelObj.senderWin];
    }
  }

  logger.info(`Closed and deallocated channel ${channelObj.channelNum}`);
};

const getChannel = (senderWin, channel) => {
  if(channel < CHANNEL_BASE) {
    return txidToChannel[senderWin]?.[channel];
  } else {
    return activeChannels[channel];
  }
};

const getChannelToSend = (targetWin, channelObj) => {
  if(!channelObj){
    return {channel: 0};
  }
  if(targetWin == channelObj.senderWin){
    return {txId: channelObj.senderCookie};
  } else {
    return {channel: channelObj.channelNum};
  }
};

// ------------------------------------------------------------------------
// Actual intent routing
// ------------------------------------------------------------------------
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

  if (xintentIntent.payload.Accept) {
    if(getChannel(senderWin, channel)){
      // throw new Error(400, 'txId cookie already in use');
      logger.info(`duplicate cookie ${xintentIntent.payload.txId}`);
      return;
    }
    channelObj = newChannel(senderWin, channel, xintentIntent);
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

const getChannelForMessage = (message) => {
  const {senderWin, channel} = message;

  const channelObj = getChannel(senderWin, channel);
  if(!channelObj && channel >= CHANNEL_BASE){
    // throw new Error(404, 'channel not found')
    logger.info(
      `Message ${intent} from sender ${widString(senderWin)} on unknown channel ${channel}`,
      xintentIntent,
      activeChannels,
    );
  }
  if(channelObj && channel >= CHANNEL_BASE){
    if(senderWin != channelObj.handlerWin){
      // throw new Error(401, 'not on channel')
      logger.info(
        `Message ${xintentIntent.payload.intent} from sender ${senderWin} not on channel ${xintentIntent.channel}`,
        xintentIntent,
        activeChannels,
      );
    }
  }
  return channelObj;
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
      implicitXBlobTransfer(message.payloadBlob, routerWin, forwardTo);
      if (message.dataBlob) {
        implicitXBlobTransfer(message.dataBlob, routerWin, forwardTo);
      }
      await sendXIntentIntentV0(X, routerWin, {
        targetWin: forwardTo,
        senderWin: routerWin,
        ...getChannelToSend(forwardTo, channelObj),
        payload: message.payload,
        payloadBlob: message.payloadBlob,
        dataBlob: message.dataBlob,
      });
      if(['final', 'cancel', 'error'].includes(message.payload.disposition)){
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

async function checkToDrainIntentsQueue(intentName) {
  const queue = intentsAwaitingServicesQueue[intentName];
  while (queue && queue.length) {
    tryToForwardTheIntent(queue.shift());
  }
}

async function getAllMatchboxToml() {
  const tree = await X.QueryTree(root);
  for (const wid of tree.children) {
    await parseWindowToml(wid);
    await parseWindowLighterToml(wid);
  }
}

async function parseWindowToml(wid) {
  try {
    const prop = await X.GetProperty(
      0,
      wid,
      atoms.XINTENT_MATCHBOX_TOML,
      0,
      0,
      1000000,
    );
    if (prop && prop.data && prop.data.length > 0) {
      const matchboxToml = TOML.parse(prop.data.toString("utf8"));
      if (matchboxToml.intents) {
        for (const intentName of Object.keys(matchboxToml.intents)) {
          if (!intentRegistry[intentName]) intentRegistry[intentName] = [];

          // Avoid duplicate bindings for the same window
          if (!intentRegistry[intentName].some((entry) => entry.wid === wid)) {
            intentRegistry[intentName].push({ wid, matchboxToml });
            checkToDrainIntentsQueue(intentName);
            logger.info(
              `Registered intent '${intentName}' -> Window ${widString(wid)}`,
            );
          }
        }
      }
    }
  } catch (err) {
    logger.error(
      `Failed parsing TOML on window ${widString(wid)}:`,
      err.message,
    );
  }
}

async function parseWindowLighterToml(wid) {
  const prop = await X.GetProperty(
    0,
    wid,
    atoms.XINTENT_SERVICES_MANIFEST,
    atoms.STRING,
    0,
    1000000,
  );
  if (prop && prop.data && prop.data.length > 0) {
    const toml = TOML.parse(prop.data.toString("utf8"));
    logger.info(
      "got XINTENT_SERVICES_MANIFEST from window",
      widString(wid),
      toml,
    );
    const computer = toml.computer;
    for (const packageName of Object.keys(toml.packages)) {
      const publicKeyHash = toml.packages[packageName].publicKeyHash;
      for (const intentName of Object.keys(
        toml.packages[packageName].intents,
      )) {
        if (!lighterRegistry[intentName]) lighterRegistry[intentName] = [];
        lighterRegistry[intentName].push({
          wid,
          computer,
          packageName,
          publicKeyHash,
        });
      }
    }
  }
}

// we need a customized version of this here that doesnt send an XBlobCreate
async function sendXIntentIntentV0(
  X,
  routerWin,
  { targetWin, senderWin, txId, channel, payload, payloadBlob, dataBlob },
) {
  if(!payloadBlob){
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
  if(dataBlob){
    implicitXBlobTransfer(dataBlob, routerWin, targetWin);
  }
  await XClientMessage(X, targetWin, atoms.XINTENT_INTENT_V0, [
    routerWin,
    payloadBlob,
    txId ?? channel ?? 0,
    dataBlob ?? 0,
  ]);
  logger.info(
    `Dispatched ${payload?.intent} to ${widString(targetWin)} (payload blob ${widString(payloadBlob)})`,
  );
  return payloadBlob;
}

/**
 * Unregisters a window that has been destroyed, cleaning up registries
 * and handling active channel lifecycles.
 */
const xintentUnregisterWindow = async (destroyedWin) => {
  logger.info(`Unregistering window ${widString(destroyedWin)}`);

  // 1. Remove window from intentRegistry
  for (const intentName of Object.keys(intentRegistry)) {
    intentRegistry[intentName] = intentRegistry[intentName].filter(
      (entry) => entry.wid !== destroyedWin
    );
    if (intentRegistry[intentName].length === 0) {
      delete intentRegistry[intentName];
    }
  }

  // 2. Remove window from lighterRegistry
  for (const intentName of Object.keys(lighterRegistry)) {
    lighterRegistry[intentName] = lighterRegistry[intentName].filter(
      (entry) => entry.wid !== destroyedWin
    );
    if (lighterRegistry[intentName].length === 0) {
      delete lighterRegistry[intentName];
    }
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
