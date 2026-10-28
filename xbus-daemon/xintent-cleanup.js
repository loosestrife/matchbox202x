// xintent-cleanup.js for xbus-daemon
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xintent-cleanup' });
const { widString } = require('../x11-promises/xintent');

function windowHasRegistrations({
  destroyedWin,
  intentRegistry,
  lighterRegistry,
  windowRegistry,
  lighterAudioRegistry,
  intentsAwaitingServicesQueue,
  activeChannels,
}) {
  if (windowRegistry[destroyedWin]) return true;
  const inEntryList = (reg) => Object.values(reg).some((entries) => entries.some((e) => e.wid === destroyedWin));
  if (inEntryList(intentRegistry) || inEntryList(lighterRegistry)) return true;
  if (Object.values(lighterAudioRegistry).some((e) => e.wid === destroyedWin)) return true;
  if (Object.values(intentsAwaitingServicesQueue).some((q) => q.some((xi) => xi.senderWin == destroyedWin))) return true;
  return Object.values(activeChannels).some((ch) => ch.senderWin === destroyedWin || ch.handlerWin === destroyedWin);
}

function pruneWindowFromRegistryMap(registryMap, destroyedWin) {
  let changed = false;
  for (const intentName of Object.keys(registryMap)) {
    const originalLen = registryMap[intentName].length;
    registryMap[intentName] = registryMap[intentName].filter((entry) => entry.wid !== destroyedWin);
    if (registryMap[intentName].length !== originalLen) {
      changed = true;
    }
    if (registryMap[intentName].length === 0) {
      delete registryMap[intentName];
    }
  }
  return changed;
}

function prunePendingQueueForSender(intentsAwaitingServicesQueue, destroyedWin) {
  for (const intentName of Object.keys(intentsAwaitingServicesQueue)) {
    intentsAwaitingServicesQueue[intentName] = intentsAwaitingServicesQueue[intentName].filter(
      (xintent) => !((xintent.senderWin == destroyedWin) && xintent.payload.Accept)
    );
    if (intentsAwaitingServicesQueue[intentName].length === 0) {
      delete intentsAwaitingServicesQueue[intentName];
    }
  }
}

async function cleanupChannelForDestroyedWindow(channelObj, ctx, retryIntents) {
  const { destroyedWin, sendXIntentIntentV0, getChannelToSend, closeChannel, X, routerWin } = ctx;
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
          intent: 'sys.Cancel',
          disposition: 'cancel',
          reason: 'connection reset by peer',
        },
      });
    }
    closeChannel(channelObj);
    return;
  }

  if (channelObj.handlerWin === destroyedWin) {
    logger.info(
      `Handler ${widString(destroyedWin)} destroyed on channel ${channelObj.channelNum}; resetting handler`
    );
    channelObj.handlerWin = null;
    if (channelObj.originalIntent) {
      retryIntents.push(channelObj.originalIntent);
    }
  }
}

async function cleanupDestroyedWindow(ctx) {
  const {
    destroyedWin,
    intentRegistry,
    lighterRegistry,
    intentsAwaitingServicesQueue,
    activeChannels,
    unregisterWindowRegistry,
    updateAggregateToml,
    tryToForwardTheFrame,
  } = ctx;

  if (windowHasRegistrations(ctx)) {
    logger.info(`Unregistering window ${widString(destroyedWin)}`);
  }

  const intentChanged = pruneWindowFromRegistryMap(intentRegistry, destroyedWin);
  const lighterChanged = pruneWindowFromRegistryMap(lighterRegistry, destroyedWin);
  const winChanged = unregisterWindowRegistry(destroyedWin);

  if ((intentChanged || lighterChanged || winChanged) && typeof updateAggregateToml === 'function') {
    await updateAggregateToml();
  }

  prunePendingQueueForSender(intentsAwaitingServicesQueue, destroyedWin);

  const retryIntents = [];
  for (const channelObj of Object.values(activeChannels)) {
    await cleanupChannelForDestroyedWindow(channelObj, ctx, retryIntents);
  }

  for (const pendingIntent of retryIntents) {
    logger.info(`Re-attempting to forward intent '${pendingIntent.payload?.intent}' after handler cleanup`);
    await tryToForwardTheFrame(pendingIntent);
  }
}

module.exports = {
  cleanupDestroyedWindow,
};
