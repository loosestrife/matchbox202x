// xintent-cleanup.js for xbus-daemon
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xintent-cleanup' });
const { widString } = require('../x11-promises/xintent');

async function cleanupDestroyedWindow({
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
}) {
  const hasRegisteredIntents = Object.values(intentRegistry).some((entries) =>
    entries.some((entry) => entry.wid === destroyedWin)
  );
  const hasLighterIntents = Object.values(lighterRegistry).some((entries) =>
    entries.some((entry) => entry.wid === destroyedWin)
  );
  const hasWindowToml = Boolean(windowRegistry[destroyedWin]);
  const hasLighterAudio = Object.values(lighterAudioRegistry).some(
    (entry) => entry.wid === destroyedWin
  );
  const hasQueuedIntents = Object.values(intentsAwaitingServicesQueue).some(
    (queue) => queue.some((xintent) => xintent.senderWin == destroyedWin)
  );
  const hasActiveChannels = Object.values(activeChannels).some(
    (channelObj) =>
      channelObj.senderWin === destroyedWin || channelObj.handlerWin === destroyedWin
  );

  const hasRegistrations =
    hasRegisteredIntents ||
    hasLighterIntents ||
    hasWindowToml ||
    hasLighterAudio ||
    hasQueuedIntents ||
    hasActiveChannels;

  if (hasRegistrations) {
    logger.info(`Unregistering window ${widString(destroyedWin)}`);
  }
  let registryChanged = false;

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

  if (registryChanged && typeof updateAggregateToml === 'function') {
    await updateAggregateToml();
  }

  for (const intentName of Object.keys(intentsAwaitingServicesQueue)) {
    intentsAwaitingServicesQueue[intentName] = intentsAwaitingServicesQueue[intentName].filter(
      (xintent) => !((xintent.senderWin == destroyedWin) && (xintent.payload.Accept))
    );
    if (intentsAwaitingServicesQueue[intentName].length === 0) {
      delete intentsAwaitingServicesQueue[intentName];
    }
  }

  const retryIntents = [];
  const channels = Object.values(activeChannels);

  for (const channelObj of channels) {
    if (channelObj.senderWin === destroyedWin) {
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
      logger.info(
        `Handler ${widString(destroyedWin)} destroyed on channel ${channelObj.channelNum}; resetting handler`
      );
      channelObj.handlerWin = null;
      if (channelObj.originalIntent) {
        retryIntents.push(channelObj.originalIntent);
      }
    }
  }

  for (const pendingIntent of retryIntents) {
    logger.info(
      `Re-attempting to forward intent '${pendingIntent.payload?.intent}' after handler cleanup`
    );
    await tryToForwardTheFrame(pendingIntent);
  }
}

module.exports = {
  cleanupDestroyedWindow,
};
