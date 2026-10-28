// xintent-policy.js for xbus-daemon
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xintent-policy' });
const policyEngine = require('../cool-intent-router');
const { widString } = require('../x11-promises/xintent');

async function queryPolicyEngineDecision({ xchannelFrame, senderWin, intent, parsedPayload, availableTargets }) {
  if (!policyEngine || typeof policyEngine.handleRouteIntent !== 'function') {
    return null;
  }
  try {
    return await policyEngine.handleRouteIntent({
      requestId: xchannelFrame.payloadBlob,
      senderApp: widString(senderWin),
      requestedIntent: intent,
      payload: parsedPayload,
      availableTargets,
    });
  } catch (err) {
    logger.error(`Error in PolicyEngine handleRouteIntent: ${err.message}`);
    return null;
  }
}

function isRejectedDecision(decision) {
  return decision === 'drop' || decision === '401' || decision === '404';
}

function selectTargetServiceEntry(registryEntries, windowRegistry, intent, targetAppId) {
  if (!targetAppId) return registryEntries[0];

  const matched = registryEntries.find(
    (entry) =>
      entry.matchboxToml?.app?.id === targetAppId ||
      entry.matchboxToml?.app?.name === targetAppId ||
      entry.appId === targetAppId
  );
  if (matched) {
    logger.info(`[intent-router] PolicyEngine matched target app '${targetAppId}' to service window (${widString(matched.wid)})`);
    return matched;
  }

  logger.info(`[intent-router] Target app '${targetAppId}' not found in active intentRegistry for ${intent}, checking windowRegistry...`);
  for (const [widStr, matchboxToml] of Object.entries(windowRegistry)) {
    if (matchboxToml?.app?.id === targetAppId || matchboxToml?.app?.name === targetAppId) {
      const numWid = Number(widStr);
      logger.info(`[intent-router] PolicyEngine matched target app '${targetAppId}' to windowRegistry window (${widString(numWid)})`);
      return { wid: numWid, matchboxToml };
    }
  }
  return registryEntries[0];
}

async function queueAndLaunchService({
  xchannelFrame,
  intent,
  actionStr,
  lighterRegistry,
  intentsAwaitingServicesQueue,
  sendXIntentIntentV0,
  X,
  routerWin,
}) {
  logger.info(
    `[intent-router] No service mapped for action: ${actionStr}, falling back to lighter ${JSON.stringify(lighterRegistry, null, 2)}`,
  );
  const existingQueue = intentsAwaitingServicesQueue[intent];
  const isAlreadyLaunching = Boolean(existingQueue && existingQueue.length > 0);
  if (!existingQueue) {
    intentsAwaitingServicesQueue[intent] = [];
  }
  intentsAwaitingServicesQueue[intent].push(xchannelFrame);

  if (isAlreadyLaunching) {
    logger.info(`[intent-router] Service '${intent}' is already launching; queued ${actionStr}`);
    return { status: 'launching' };
  }

  const lighterRegistryEntry = lighterRegistry[intent];
  if (lighterRegistryEntry && lighterRegistryEntry.length > 0) {
    const { computer, packageName, wid } = lighterRegistryEntry[0];
    await sendXIntentIntentV0(X, routerWin, {
      targetWin: wid,
      senderWin: routerWin,
      txId: 0,
      payload: {
        intent: 'sys.Launch',
        computer,
        package: packageName,
        intendedIntent: intent,
      },
    });
  } else {
    logger.error(`no launchable service found for ${actionStr}`);
  }
  return { status: 'launching' };
}

async function evaluateRoutePolicy(ctx) {
  const {
    xchannelFrame,
    intent,
    parsedPayload,
    intentRegistry,
    windowRegistry,
    formatActionString,
  } = ctx;
  const { senderWin } = xchannelFrame;
  const actionStr = formatActionString ? formatActionString(xchannelFrame) : intent;
  const registryEntries = intentRegistry[intent] || [];
  const availableTargets = registryEntries.map((e) => e.matchboxToml?.app?.id).filter(Boolean);

  const routeDecision = await queryPolicyEngineDecision({
    xchannelFrame,
    senderWin,
    intent,
    parsedPayload,
    availableTargets,
  });

  if (isRejectedDecision(routeDecision?.decision)) {
    logger.info(`[intent-router] PolicyEngine rejected intent ${intent} (decision: ${routeDecision.decision})`);
    return { status: 'rejected', decision: routeDecision?.decision };
  }

  const targetAppId = routeDecision?.targetApp || parsedPayload?.app || parsedPayload?.targetApp;
  if (registryEntries.length > 0) {
    const selectedEntry = selectTargetServiceEntry(registryEntries, windowRegistry, intent, targetAppId);
    return { status: 'matched', selectedEntry, targetAppId };
  }

  return await queueAndLaunchService({ ...ctx, actionStr });
}

module.exports = {
  evaluateRoutePolicy,
};
