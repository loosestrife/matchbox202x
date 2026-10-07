const { on } = require('node:events');
const TOML = require('@iarna/toml');
const { Logger, HttpError, alStorage } = require('../server-tools');
const xintent = require('../x11-promises/xintent');

const logger = new Logger({ module: 'route-intent' });
let clientWin, X, root;
let globalTransactionIdCounter = 1;

/**
 * Reads the aggregated TOML property off routerWin
 */
const fetchAggregateToml = async () => {
  const targetWin = xintent.routerWin;
  const atom = xintent.atoms.XINTENT_AGGREGATE_TOML;

  try {
    logger.info('tryna get AGGREGATE_TOML');
    const prop = await X.GetProperty(0, targetWin, atom, 0, 0, 1000000);
    if (prop && prop.data && prop.data.length > 0) {
      return prop.data.toString('utf8');
    }
  } catch (err) {
    logger.error(`[AGGREGATE TOML] Failed to fetch aggregate property: ${err.message}`);
  }
  return null;
};

/**
 * HTTP Handler to advertise available intents bus manifest
 * Supports returning raw TOML or parsed JSON based on headers/query parameters.
 */
const getAggregateToml = async (req, res) => {
  console.log('call to get aggregate toml');
  const rawToml = await fetchAggregateToml();

  if (!rawToml) {
    throw new HttpError(503, 'Aggregate intents manifest not available');
  }

  res.setHeader('Matchbox-Bridge', '1.0');

  const acceptHeader = req.headers.accept || '';
  if (
    req.query.format === 'toml' ||
    acceptHeader.includes('text/x-toml') ||
    acceptHeader.includes('application/toml')
  ) {
    res.setHeader('Content-Type', 'text/x-toml; charset=utf-8');
    return res.status(200).send(rawToml);
  }

  try {
    const parsedManifest = TOML.parse(rawToml);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json(parsedManifest);
  } catch (err) {
    logger.error(`[AGGREGATE TOML] Failed to parse aggregate TOML string: ${err.message}`);
    res.setHeader('Content-Type', 'text/x-toml; charset=utf-8');
    return res.status(200).send(rawToml);
  }
};

const aggregateTomlAsObject = async () => {
  const rawToml = await fetchAggregateToml();
  const parsedManifest = TOML.parse(rawToml);
  return parsedManifest;
};

const routeIntent = async (req, res) => {
  const { namespace, action } = req.params;
  const intent = `${namespace}.${action}`;
  const payload = req.body || {};

  // If query string app is provided but missing from body payload, populate it
  if (req.query.app && !payload.app) {
    payload.app = req.query.app;
  }

  // If both query string app and body app are provided, enforce advisory match
  if (req.query.app && payload.app && req.query.app !== payload.app) {
    throw new HttpError(400, `advisory query string app specification (${req.query.app}) must match app specified in intent json (${payload.app}): ${JSON.stringify(payload)}`);
  }

  if (payload.intent && intent !== payload.intent) {
    throw new HttpError(400, `url path intent (${intent}) must match intent specified in intent json (${payload.intent}): ${JSON.stringify(payload)}`);
  }

  if (!payload.intent) {
    payload.intent = intent;
  }

  const targetApp = payload.app;

  // Store intent context in AsyncLocalStorage so all error logs include the intent JSON
  logger.setContext({
    intent,
    targetApp: targetApp || undefined,
    intentJson: payload
  });

  logger.info(`[INTENT] ${intent}${targetApp ? ` -> Target: ${targetApp}` : ''}`, payload);
  const txId = globalTransactionIdCounter++;

  try {
    // --- 1. Streamed Multipart Response Path ---
    if (payload.Accept) {
      let headersSent = false;
      const BOUNDARY = 'MatchboxFrameBoundary_' + Date.now().toString(16);

      const writeJsonFrame = (res, data, customHeaders = {}) => {
        if (!headersSent) {
          res.writeHead(200, {
            'Content-Type': `multipart/mixed; boundary=${BOUNDARY}`,
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'Matchbox-Bridge': '1.0',
          });
          headersSent = true;
        }
        const jsonBody = JSON.stringify(data, null, 2);
        const headers = [
          'Content-Type: application/json',
          'Content-Disposition: inline',
          `Content-Length: ${Buffer.byteLength(jsonBody)}`,
          ...Object.entries(customHeaders).map(([key, val]) => `${key}: ${val}`)
        ];

        res.write(`--${BOUNDARY}\r\n${headers.join('\r\n')}\r\n\r\n${jsonBody}\r\n\r\n`);
      };

      const responsePromise = new Promise((resolve, reject) => {
        const responseHandler = async (ev) => {
          if (
            ev &&
            ev.type == 33 &&
            [xintent.atoms.XINTENT_INTENT_V0, xintent.atoms.XINTENT_EVENT_V0].includes(ev.message_type) &&
            ev.data &&
            ev.data[2] == txId
          ) {
            try {
              const routerWin = await xintent.getValidRouterWin(X, root);
              const { payload: eventData } = await xintent.parseXIntentIntentV0(X, routerWin, ev);

              writeJsonFrame(res, eventData);

              const blobAtom = ev.data[3];
              if (blobAtom) {
                try {
                  const blob = await xintent.XBlobRead(X, routerWin, blobAtom);
                  xintent.XBlobUnlink(X, routerWin, clientWin, blobAtom);

                  if (blob) {
                    writeJsonFrame(res, blob);
                  }
                } catch (err) {
                  logger.error(`[BLOB READ ERROR] Failed to fetch blob atom ${blobAtom} for intent ${intent}: ${err.message}`, { intentPayload: payload });
                }
              }

              // Finalize stream when disposition is final or error
              if (eventData.disposition === 'final' || eventData.disposition === 'error') {
                logger.info("Closing stream", {txId});
                if (headersSent) {
                  res.write(`--${BOUNDARY}--\r\n`);
                  res.end();
                }
                X.removeListener('event', responseHandler);
                resolve();
              }
            } catch (err) {
              logger.error(`[STREAM ERROR] ${err.message}`);
              X.removeListener('event', responseHandler);
              if (headersSent) {
                res.end();
              } else {
                reject(err);
              }
              resolve();
            }
          }
        };

        X.on('event', responseHandler);
      });

      const routerWin = await xintent.getValidRouterWin(X, root);
      await xintent.sendXIntentIntentV0(X, routerWin, {
        senderWin: clientWin,
        payload,
        txId,
      });

      return await responsePromise;
    }

    // --- 2. Fire-and-Forget / Standard Response Path ---
    await xintent.sendXIntentIntentV0(X, xintent.routerWin, {
      senderWin: clientWin,
      payload,
      txId,
    });

    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', intent, targetApp });
  } catch (err) {
    logger.error(
      `[ROUTE INTENT ERROR] ${intent}${targetApp ? ` to ${targetApp}` : ''} failed: ${err.message}`,
      err.stack || err,
      { intentPayload: payload }
    );
    throw err;
  }
};

module.exports = ({ X: xClient, root: xRoot, clientWin: theClientWin }) => {
  X = xClient;
  root = xRoot;
  clientWin = theClientWin;

  return {
    routeIntent,
    getAggregateToml,
    fetchAggregateToml,
    aggregateTomlAsObject,
  };
};
