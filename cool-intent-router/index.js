const { checkXSecurePolicy, rules, authentication } = require('./xsecure');
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'cool-intent-policy-engine' });

/**
 * Handles incoming bus.RouteIntent request from the Busmaster
 */
async function handleRouteIntent(req) {
  const { requestId, senderApp, requestedIntent, payload, availableTargets } = req;
  logger.info(`[PolicyEngine] Evaluating bus.RouteIntent: ${requestedIntent} from ${senderApp || 'unknown'}`);

  const securityContext = {
    source: { app: senderApp },
    action: requestedIntent,
  };

  const securityPolicy = await checkXSecurePolicy(securityContext, { payload }, {});

  if (securityPolicy === 'drop' || securityPolicy === '401' || securityPolicy === '404') {
    return {
      requestId,
      decision: securityPolicy,
      targetApp: null,
    };
  }

  // Determine target app routing policy
  let targetApp = payload?.app;
  if (!targetApp && availableTargets && availableTargets.length > 0) {
    targetApp = availableTargets[0];
  }

  return {
    requestId,
    decision: 'accept',
    targetApp: targetApp || null,
    modifiedPayload: null,
  };
}

/**
 * Command: bus.ListChannels
 */
function handleListChannels(activeChannels) {
  logger.info(`[PolicyEngine] Querying ${activeChannels.length} active channels`);
  return {
    event: 'bus.ListChannelsResponse',
    channels: activeChannels,
  };
}

/**
 * Command: bus.RedirectIntent
 */
function handleRedirectIntent(channelId, newTargetApp, redirectFn) {
  logger.info(`[PolicyEngine] Redirecting channel ${channelId} -> ${newTargetApp}`);
  const success = typeof redirectFn === 'function' ? redirectFn(channelId, newTargetApp) : false;
  return {
    event: 'bus.RedirectIntentResponse',
    channelId,
    success,
    currentTargetApp: newTargetApp,
  };
}

/**
 * Command: bus.CloseChannel
 */
function handleCloseChannel(channelId, reason, closeFn) {
  logger.info(`[PolicyEngine] Closing channel ${channelId}: ${reason || 'Policy Enforcement'}`);
  const success = typeof closeFn === 'function' ? closeFn(channelId) : false;
  return {
    event: 'bus.CloseChannelResponse',
    channelId,
    success,
  };
}

logger.info('XIntent Policy Engine initialized.');

module.exports = {
  checkXSecurePolicy,
  rules,
  authentication,
  handleRouteIntent,
  handleListChannels,
  handleRedirectIntent,
  handleCloseChannel,
};
