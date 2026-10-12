const { Logger } = require("../server-tools");
const { atoms, widString, frameType, frameDesc } = require("../x11-promises/xintent");
const logger = new Logger({ module: "xbus-channels" });

// Channel & Service Registry State
const activeChannels = {};      // channelNum -> channelObj
const txidToChannel = {};       // senderWin -> { [txId]: channelObj }

const CHANNEL_BASE = 16777216;  // 0x01000000 (24-bit boundary)
const MAX_UINT32   = 4294967295; // 0xFFFFFFFF

let channelSerialNumberStamp = CHANNEL_BASE;

/**
 * Allocates a new server channel >= 16,777,216 for a client request.
 */
const newChannel = (senderWin, txId, xintentIntent) => {
  if (txidToChannel[senderWin] && txidToChannel[senderWin][txId]) {
    const existingObj = txidToChannel[senderWin][txId];
    logger.info(`Reusing existing active channel ${existingObj.channelNum} for client ${widString(senderWin)} (txId: ${txId})`);
    return existingObj;
  }

  let channelNum;
  do {
    channelNum = channelSerialNumberStamp++;
    if (channelSerialNumberStamp > MAX_UINT32) {
      channelSerialNumberStamp = CHANNEL_BASE;
    }
  } while (activeChannels[channelNum]);

  const channelObj = {
    channelNum,
    senderWin,
    senderCookie: txId, // Original 24-bit client txId
    handlerWin: null,   // Bound once mapped to a service window
    intent: frameType(xintentIntent),
    xintentIntent,
  };

  activeChannels[channelNum] = channelObj;

  if (!txidToChannel[senderWin]) {
    txidToChannel[senderWin] = {};
  }
  txidToChannel[senderWin][txId] = channelObj;

  logger.info(`Allocated channel ${channelNum} for ${frameDesc(xintentIntent)} (cookie txId: ${txId})`);
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

  logger.info(`Closed and deallocated channel ${channelObj.channelNum} (${channelObj.intent || 'unknown'})`);
};

const getChannel = (senderWin, channel) => {
  if (channel < CHANNEL_BASE) {
    return txidToChannel[senderWin]?.[channel];
  } else {
    return activeChannels[channel];
  }
};

const getChannelToSend = (targetWin, channelObj) => {
  if (!channelObj) {
    return { channel: 0 };
  }
  if (targetWin == channelObj.senderWin) {
    return { txId: channelObj.senderCookie };
  } else {
    return { channel: channelObj.channelNum };
  }
};

const getChannelForMessage = (message) => {
  if (!message) return null;
  const { senderWin, channel } = message;

  const channelObj = getChannel(senderWin, channel);
  if (!channelObj && channel >= CHANNEL_BASE) {
    logger.info(
      `Frame ${frameDesc(message)} on unknown channel ${channel}`
    );
  }
  if (channelObj && channel >= CHANNEL_BASE) {
    if (senderWin !== channelObj.handlerWin && senderWin !== channelObj.senderWin) {
      logger.info(
        `Frame ${frameDesc(message)} not registered on channel ${channel}`
      );
    }
  }
  return channelObj;
};

const listActiveChannels = () => Object.values(activeChannels);

const redirectChannel = (channelNum, newHandlerWin) => {
  const channelObj = activeChannels[channelNum];
  if (!channelObj) return false;
  channelObj.handlerWin = newHandlerWin;
  return true;
};

module.exports = {
  activeChannels,
  txidToChannel,
  newChannel,
  closeChannel,
  getChannel,
  getChannelToSend,
  getChannelForMessage,
  listActiveChannels,
  redirectChannel,
};
