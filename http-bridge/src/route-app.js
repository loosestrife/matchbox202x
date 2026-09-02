const {Logger, HttpError} = require('./server-tools');
const {packageRegistry, intentRegistry} = require('./package-registry');

const logger = Logger({module: 'route-intent'});

module.exports.routeApp = (req, res) => {
  const package = packageRegistry[req.params.app];
  const appName = req.params.app;
  if(!package) throw new HttpError(400, `package ${appName} not found`);
  const app = package.app;
  if(!app) throw new HttpError(400, `package ${appName} is not an app`);
  let cardId;
  if(req.params.card){
    cardId = req.params.card;
  } else {
    if(app.main?.type != "html") throw new HttpError(400, `cant serve main type ${app.main?.type} of ${appName}`);
    cardId = app.main.card;
  }
  const card = package.cards.filter(c => c.id == cardId)[0];
  let cardPath = card.path;
  if(!(card.path.startsWith('/'))){
    cardPath = path.join(package._path, cardPath);
  }
  logger.info(`sending ${cardPath}`)
  res.sendFile(cardPath);
}