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

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const x11 = require('../x11-promises/x11-promises');
  const xintent = require('../x11-promises/xintent');

  async function startStandalonePolicyEngine() {
    const { X, root } = await x11.createClientWithPromises();
    const routerWin = await xintent.connectToRouter(X, root, 5000);
    if (!routerWin) {
      logger.error('Failed to connect to XIntent router window');
      process.exit(1);
    }

    const policyWin = await xintent.createClientWindow(X, root, 'xintent-policy-engine');
    const matchboxTomlPath = path.join(__dirname, 'matchbox.toml');
    if (fs.existsSync(matchboxTomlPath)) {
      const matchboxToml = fs.readFileSync(matchboxTomlPath, 'utf8');
      const matchboxAtom = await X.InternAtom(false, 'MATCHBOX_TOML');
      const stringAtom = await X.InternAtom(false, 'STRING');
      X.ChangeProperty(0, policyWin, matchboxAtom, stringAtom, 8, Buffer.from(matchboxToml, 'utf8'));
    }

    logger.info(`[Standalone IPC] Policy Engine online on window ${xintent.widString(policyWin)} (Busmaster: ${xintent.widString(routerWin)})`);

    X.on('event', async (ev) => {
      if (ev.type === 33 && (ev.message_type === xintent.atoms.XINTENT_INTENT_V0 || ev.message_type === xintent.atoms.XINTENT_EVENT_V0)) {
        try {
          const parsed = await xintent.parseXIntentIntentV0(X, routerWin, ev);
          if (!parsed || !parsed.payload) return;
          const { senderWin, channel, payload } = parsed;
          const actionName = payload.intent || payload.event || payload.action;

          logger.info(`[Standalone IPC] Received request '${actionName}' on channel ${channel} from ${xintent.widString(senderWin)}`);

          let responsePayload = null;
          if (actionName === 'bus.RouteIntent') {
            responsePayload = await handleRouteIntent(payload);
          } else if (actionName === 'bus.ListChannels') {
            responsePayload = handleListChannels(payload.channels || []);
          } else if (actionName === 'bus.RedirectIntent') {
            responsePayload = handleRedirectIntent(payload.channelId, payload.targetApp);
          } else if (actionName === 'bus.CloseChannel') {
            responsePayload = handleCloseChannel(payload.channelId, payload.reason);
          } else if (actionName === 'sys.RerouteIntent') {
            const securityPolicy = await checkXSecurePolicy({ source: { window: senderWin }, action: actionName }, { payload }, {});
            responsePayload = {
              event: 'sys.RerouteIntentResponse',
              decision: securityPolicy,
            };
          }

          if (responsePayload) {
            await xintent.sendXIntentEventV0(X, routerWin, {
              senderWin: policyWin,
              channel,
              payload: responsePayload,
            });
          }
        } catch (err) {
          logger.error('[Standalone IPC] Error handling policy frame:', err.message);
        }
      }
    });
  }

  startStandalonePolicyEngine().catch((err) => {
    logger.error('Fatal error in Policy Engine daemon:', err);
    process.exit(1);
  });
}
