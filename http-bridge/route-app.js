const path = require('path');
const {Logger, HttpError} = require('../server-tools');
const {packageRegistry, intentRegistry} = require('./package-registry');

const logger = new Logger({module: 'route-intent'});

module.exports.routeApp = (req, res) => {
  logger.info(`request for app ${req.params.app} card ${req.params.card}`);
  logger.debug('packages are', Object.keys(packageRegistry));
  const package = packageRegistry[req.params.app];
  logger.debug('package is', package);
  const appName = req.params.app;
  if(!package) throw new HttpError(400, `package ${appName} not found`);
  const app = package.app;
  logger.debug('package.app', app);
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