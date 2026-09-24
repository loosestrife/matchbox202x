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
    for await (const [ev] of on(X, 'event')) {
      if (ev.type == 33 &&
        [xintent.atoms.XINTENT_INTENT_V0, xintent.atoms.XINTENT_EVENT_V0].includes(ev.message_type) && 
        ev.data[2] == txId
      ) {
        const { payload: eventData, payloadAtom } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
        console.log('[EVENT RECEIVED]', eventData);
        if(eventData.disposition == 'final'){
          res.status(200).json(eventData);
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