const path = require('path');
const fs = require('fs');
const {Logger, HttpError} = require('../server-tools');
const {packageRegistry, intentRegistry} = require('./package-registry');

const logger = new Logger({module: 'route-intent'});

module.exports.routeApp = (req, res) => {
  logger.info(`request for app ${req.params.app} card ${req.params.card}`);

  if (req.params.app === 'favicon.ico') {
    return res.sendFile(path.join(__dirname, 'assets', 'favicon.ico'));
  }

  if (req.params.card === 'favicon.ico') {
    const package = packageRegistry[req.params.app];
    if (package && package._path) {
      const localFavicon = path.join(package._path, 'favicon.ico');
      if (fs.existsSync(localFavicon)) {
        return res.sendFile(localFavicon);
      }
    }
    return res.sendFile(path.join(__dirname, 'assets', 'favicon.ico'));
  }

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
  const card = (package.cards || []).find(c => c.id == cardId);
  if(!card) throw new HttpError(404, `card ${cardId} not found in package ${appName}`);
  let cardPath = card.path;
  if(!(card.path.startsWith('/'))){
    cardPath = path.join(package._path, cardPath);
  }
  logger.info(`sending ${cardPath}`)
  res.sendFile(cardPath);
}

module.exports.getApps = () => Object.fromEntries(
  Object.entries(packageRegistry)
    .filter(([_, pkg]) => pkg?.app && pkg?.app?.main?.type == 'html')
    .map(([appId, pkg]) => [
      appId,
      {
        name: pkg.app.name || appId,
        description: pkg.app.description || '',
        mainCard: pkg.app.main?.card || null,
        cards: (pkg.cards || []).map(card => card.id)
      }
    ])
);