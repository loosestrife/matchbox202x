const { Logger, HttpError } = require('../server-tools');
const { connectToRouter, createClientWindow, sendXIntentIntentV0, XBlobCreate, XBlobTransfer } = require('../x11-promises/xintent');

const logger = new Logger({module: 'route-intent'});
let routerWin, clientWin;
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
  await sendXIntentIntentV0(X, routerWin, {
    senderWin: clientWin,
    payload,
    txId,
  });
  if(payload.reply){
    for await (const [ev] of on(X, 'event')) {
      if (ev.type == 33 &&
        [atoms.XINTENT_INTENT_V0, atoms.XINTENT_EVENT_V0].includes(ev.message_type) && 
        ev.data[2] == txId
      ) {
        const { payload: eventData, payloadAtom } = await parseXIntentIntentV0(X, routerWin, ev);
        console.log('[EVENT RECEIVED]', eventData);
        if (eventData.disposition === 'final') {
          return eventData;
        }
      }
    }
  }
  res.status(200).json({ status: 'ok', intent, targetApp });
};

module.exports = ({ routerWin: theRouterWin, X: xClient, root: xRoot, cleintWin: theClientWin}) => {
  routerWin = theRouterWin;
  X = xClient;
  root = xRoot;
  clientWin = theClientWin;

  return { routeIntent };
};