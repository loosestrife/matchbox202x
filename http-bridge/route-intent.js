const { on } = require('node:events');
const { Logger, HttpError } = require('../server-tools');
const xintent = require('../x11-promises/xintent');

const logger = new Logger({module: 'route-intent'});
let routerWin, clientWin, X, root;
let globalTransactionIdCounter = 1;

const routeIntent = async (req, res) => {
  const { namespace, action } = req.params;
  const intent = `${namespace}.${action}`;
  const targetApp = req.query.app || req.body.app;
  if(req.query.app && req.query.app != req.body.app)
    throw new HttpError(400, 'advisory query string app specification must match app specified in intent json');
  if(intent != req.body.intent)
    throw new HttpError(400, 'url path intent must match intent specified in intent json');
  const payload = req.body;
  logger.info(`[INTENT] ${intent} -> Target: ${targetApp}`);
  res.setHeader('Matchbox-Bridge', '1.0');
  const txId = globalTransactionIdCounter++;
  await xintent.sendXIntentIntentV0(X, xintent.routerWin, {
    senderWin: clientWin,
    payload,
    txId,
  });
  if(payload.reply){
    const BOUNDARY = 'MatchboxFrameBoundary_' + Date.now().toString(16);
    const writeJsonFrame = (res, data) => res.write(`--${BOUNDARY}
Content-Type: application/json
Content-Disposition: inline

${JSON.stringify(data, null, 2)}

`.split('\n').join('\r\n')
    );
    const writeBlobFrame = (res, blobBuffer, contentType = 'application/octet-stream') => {
      res.write(`--${BOUNDARY}
Content-Type: ${contentType}
${filename? `Content-Disposition: attachment; filename="${filename}`:'Content-Disposition: inline'}

`.split('\n').join('\r\n'));
      res.write(blobBuffer);
      res.write('\r\n');
    };
    for await (const [ev] of on(X, 'event')) {
      if (ev.type == 33 &&
        [xintent.atoms.XINTENT_INTENT_V0, xintent.atoms.XINTENT_EVENT_V0].includes(ev.message_type) && 
        ev.data[2] == txId
      ) {
        const { payload: eventData, payloadAtom } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
        console.log('[EVENT RECEIVED]', eventData);

        // 1. Stream JSON frame[cite: 8]
        writeJsonFrame(res, eventData);

        // 2. Stream Data Blob frame if ev.data[3] contains a valid blob atom/descriptor[cite: 8]
        const blobAtom = ev.data[3];
        if (blobAtom) {
          try {
            // Read binary buffer associated with blob atom[cite: 8]
            const blobBuffer = await xintent.XBlobRead(X, xintent.routerWin, blobAtom);
            xintent.XBlobUnlink(X, xintent.routerWin, clientWin, blobAtom);
            if (blobBuffer && blobBuffer.length > 0) {
              const contentType = eventData.type;
              writeBlobFrame(res, blobBuffer, contentType, filename);
            }
          } catch (err) {
            logger.error(`[BLOB READ ERROR] Failed to fetch blob atom ${blobAtom}: ${err.message}`);
          }
        }

        // 3. Finalize stream when disposition is final[cite: 7, 8]
        if (eventData.disposition === 'final') {
          res.write(`--${BOUNDARY}--\r\n`);
          res.end();
          return;
        }
      }
    }
  }
  res.status(200).json({ status: 'ok', intent, targetApp });
};

module.exports = ({ routerWin: theRouterWin, X: xClient, root: xRoot, clientWin: theClientWin}) => {
  X = xClient;
  root = xRoot;
  clientWin = theClientWin;

  return { routeIntent };
};