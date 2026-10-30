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

function parseHostQualifiedAppId(targetAppId) {
  if (!targetAppId || typeof targetAppId !== 'string' || !targetAppId.includes(':')) {
    return { targetHost: null, targetPkg: targetAppId || null };
  }
  const idx = targetAppId.indexOf(':');
  return {
    targetHost: targetAppId.slice(0, idx),
    targetPkg: targetAppId.slice(idx + 1),
  };
}

function matchesAppIdOrPkg(appObj, targetAppId, targetPkg) {
  if (!appObj) return false;
  return (
    appObj.id === targetAppId ||
    appObj.name === targetAppId ||
    (Boolean(targetPkg) && (appObj.id === targetPkg || appObj.name === targetPkg))
  );
}

function selectTargetServiceEntry(registryEntries, windowRegistry, intent, targetAppId) {
  if (!targetAppId) return registryEntries[0];
  const { targetHost, targetPkg } = parseHostQualifiedAppId(targetAppId);

  const hostMatched = targetHost
    ? registryEntries.find(
        (entry) =>
          matchesAppIdOrPkg(entry.matchboxToml?.app, targetAppId, targetPkg) &&
          entry.matchboxToml?.computer?.host === targetHost
      )
    : null;
  const matched =
    hostMatched ||
    registryEntries.find(
      (entry) =>
        matchesAppIdOrPkg(entry.matchboxToml?.app, targetAppId, targetPkg) ||
        entry.appId === targetAppId ||
        (Boolean(targetPkg) && entry.appId === targetPkg)
    );
  if (matched) {
    logger.info(`[intent-router] PolicyEngine matched target app '${targetAppId}' to service window (${widString(matched.wid)})`);
    return matched;
  }

  logger.info(`[intent-router] Target app '${targetAppId}' not found in active intentRegistry for ${intent}, checking windowRegistry...`);
  for (const [widStr, matchboxToml] of Object.entries(windowRegistry)) {
    if (matchesAppIdOrPkg(matchboxToml?.app, targetAppId, targetPkg)) {
      const numWid = Number(widStr);
      logger.info(`[intent-router] PolicyEngine matched target app '${targetAppId}' to windowRegistry window (${widString(numWid)})`);
      return { wid: numWid, matchboxToml };
    }
  }
  return registryEntries[0];
}

function selectLighterEntry(lighterEntries, targetAppId) {
  if (!lighterEntries || lighterEntries.length === 0) return null;
  if (!targetAppId) return lighterEntries[0];
  const { targetHost, targetPkg } = parseHostQualifiedAppId(targetAppId);
  if (targetHost && targetPkg) {
    const exact = lighterEntries.find(
      (e) => (e.packageName === targetPkg || e.name === targetPkg) && e.computer?.host === targetHost
    );
    if (exact) return exact;
  }
  if (targetPkg) {
    const pkgMatch = lighterEntries.find((e) => e.packageName === targetPkg || e.name === targetPkg);
    if (pkgMatch) return pkgMatch;
  }
  return lighterEntries[0];
}

async function queueAndLaunchService(ctx) {
  const {
    xchannelFrame,
    intent,
    actionStr,
    targetAppId,
    lighterRegistry,
    intentsAwaitingServicesQueue,
    sendXIntentIntentV0,
    X,
    routerWin,
  } = ctx;
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

  let chosenLighter = selectLighterEntry(lighterRegistry[intent], targetAppId);
  if (!chosenLighter && typeof ctx?.getAllMatchboxToml === 'function') {
    await ctx.getAllMatchboxToml();
    chosenLighter = selectLighterEntry(lighterRegistry[intent], targetAppId);
  }
  if (chosenLighter) {
    const { computer, packageName, wid } = chosenLighter;
    await sendXIntentIntentV0(X, routerWin, {
      targetWin: wid,
      senderWin: routerWin,
      txId: 0,
      payload: {
        intent: 'sys.Launch',
        computer,
        package: packageName,
        intendedIntent: intent,
        targetApp: targetAppId || undefined,
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

  return await queueAndLaunchService({ ...ctx, actionStr, targetAppId });
}

module.exports = {
  evaluateRoutePolicy,
};
