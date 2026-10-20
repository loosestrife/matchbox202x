// xintent-policy.js for xbus-daemon
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xintent-policy' });
const policyEngine = require('../cool-intent-router');
const { widString } = require('../x11-promises/xintent');

async function evaluateRoutePolicy({
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
}) {
  const { senderWin } = xchannelFrame;
  const actionStr = formatActionString ? formatActionString(xchannelFrame) : intent;
  const registryEntries = intentRegistry[intent] || [];
  const availableTargets = registryEntries.map((e) => e.matchboxToml?.app?.id).filter(Boolean);

  let routeDecision = null;
  if (policyEngine && typeof policyEngine.handleRouteIntent === 'function') {
    try {
      routeDecision = await policyEngine.handleRouteIntent({
        requestId: xchannelFrame.payloadBlob,
        senderApp: widString(senderWin),
        requestedIntent: intent,
        payload: parsedPayload,
        availableTargets,
      });
    } catch (err) {
      logger.error(`Error in PolicyEngine handleRouteIntent: ${err.message}`);
    }
  }

  if (routeDecision?.decision === 'drop' || routeDecision?.decision === '401' || routeDecision?.decision === '404') {
    logger.info(`[intent-router] PolicyEngine rejected intent ${intent} (decision: ${routeDecision.decision})`);
    return { status: 'rejected', decision: routeDecision?.decision };
  }

  const targetAppId = routeDecision?.targetApp || parsedPayload?.app || parsedPayload?.targetApp;

  if (registryEntries.length > 0) {
    let selectedEntry = registryEntries[0];
    if (targetAppId) {
      const matched = registryEntries.find(
        (entry) =>
          entry.matchboxToml?.app?.id === targetAppId ||
          entry.matchboxToml?.app?.name === targetAppId ||
          entry.appId === targetAppId
      );
      if (matched) {
        selectedEntry = matched;
        logger.info(`[intent-router] PolicyEngine matched target app '${targetAppId}' to service window (${widString(matched.wid)})`);
      } else {
        logger.info(`[intent-router] Target app '${targetAppId}' not found in active intentRegistry for ${intent}, checking windowRegistry...`);
        for (const [widStr, matchboxToml] of Object.entries(windowRegistry)) {
          if (matchboxToml?.app?.id === targetAppId || matchboxToml?.app?.name === targetAppId) {
            const numWid = Number(widStr);
            selectedEntry = { wid: numWid, matchboxToml };
            logger.info(`[intent-router] PolicyEngine matched target app '${targetAppId}' to windowRegistry window (${widString(numWid)})`);
            break;
          }
        }
      }
    }

    return { status: 'matched', selectedEntry, targetAppId };
  } else {
    logger.info(
      `[intent-router] No service mapped for action: ${actionStr}, falling back to lighter ${JSON.stringify(lighterRegistry, null, 2)}`,
    );
    const isAlreadyLaunching = intentsAwaitingServicesQueue[intent] && intentsAwaitingServicesQueue[intent].length > 0;
    if (!intentsAwaitingServicesQueue[intent]) {
      intentsAwaitingServicesQueue[intent] = [];
    }
    intentsAwaitingServicesQueue[intent].push(xchannelFrame);

    if (!isAlreadyLaunching) {
      const lighterRegistryEntry = lighterRegistry[intent];
      if (lighterRegistryEntry && lighterRegistryEntry.length > 0) {
        const { computer, packageName, wid, publicKeyHash } = lighterRegistryEntry[0];
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
        logger.error(`no launchable service found for ${actionStr}`);
      }
    } else {
      logger.info(`[intent-router] Service '${intent}' is already launching; queued ${actionStr}`);
    }
    return { status: 'launching' };
  }
}

module.exports = {
  evaluateRoutePolicy,
};
