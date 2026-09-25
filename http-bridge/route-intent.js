const { on } = require('node:events');
const { Logger, HttpError } = require('../server-tools');
const xintent = require('../x11-promises/xintent');

const logger = new Logger({ module: 'route-intent' });
let routerWin, clientWin, X, root;
let globalTransactionIdCounter = 1;

const routeIntent = async (req, res) => {
  const { namespace, action } = req.params;
  const intent = `${namespace}.${action}`;
  const targetApp = req.query.app || req.body.app;

  if (req.query.app && req.query.app != req.body.app) {
    throw new HttpError(400, 'advisory query string app specification must match app specified in intent json');
  }
  if (intent != req.body.intent) {
    throw new HttpError(400, 'url path intent must match intent specified in intent json');
  }

  const payload = req.body;
  logger.info(`[INTENT] ${intent} -> Target: ${targetApp}`);
  const txId = globalTransactionIdCounter++;

  // --- 1. Streamed Multipart Response Path ---
  if (payload.reply) {
    const BOUNDARY = 'MatchboxFrameBoundary_' + Date.now().toString(16);

    res.writeHead(200, {
      'Content-Type': `multipart/mixed; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Matchbox-Bridge': '1.0',
    });

    const writeJsonFrame = (res, data, customHeaders = {}) => {
      const jsonBody = JSON.stringify(data, null, 2);
      const headers = [
        'Content-Type: application/json',
        'Content-Disposition: inline',
        `Content-Length: ${Buffer.byteLength(jsonBody)}`,
        ...Object.entries(customHeaders).map(([key, val]) => `${key}: ${val}`)
      ];

      res.write(`--${BOUNDARY}\r\n${headers.join('\r\n')}\r\n\r\n${jsonBody}\r\n\r\n`);
    };

    await xintent.sendXIntentIntentV0(X, xintent.routerWin, {
      senderWin: clientWin,
      payload,
      txId,
    });

    for await (const [ev] of on(X, 'event')) {
      if (
        ev.type == 33 &&
        [xintent.atoms.XINTENT_INTENT_V0, xintent.atoms.XINTENT_EVENT_V0].includes(ev.message_type) && 
        ev.data[2] == txId
      ) {
        const { payload: eventData } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
        console.log('[EVENT RECEIVED]', eventData);

        writeJsonFrame(res, eventData);

        const blobAtom = ev.data[3];
        if (blobAtom) {
          try {
            const blob = await xintent.XBlobRead(X, xintent.routerWin, blobAtom);
            xintent.XBlobUnlink(X, xintent.routerWin, clientWin, blobAtom);
            
            if (blob) {
              writeJsonFrame(res, blob);
            }
          } catch (err) {
            logger.error(`[BLOB READ ERROR] Failed to fetch blob atom ${blobAtom}: ${err.message}`);
          }
        }

        // Finalize stream when disposition is final
        if (eventData.disposition === 'final') {
          res.write(`--${BOUNDARY}--\r\n`);
          res.end();
          return;
        }
      }
    }
  }

  // --- 2. Fire-and-Forget / Standard Response Path ---
  await xintent.sendXIntentIntentV0(X, xintent.routerWin, {
    senderWin: clientWin,
    payload,
    txId,
  });

  res.setHeader('Matchbox-Bridge', '1.0');
  res.status(200).json({ status: 'ok', intent, targetApp });
};

module.exports = ({ routerWin: theRouterWin, X: xClient, root: xRoot, clientWin: theClientWin }) => {
  X = xClient;
  root = xRoot;
  clientWin = theClientWin;

  return { routeIntent };
};