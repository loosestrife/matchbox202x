const path = require('path');
const fs = require('fs');
const {Logger, HttpError} = require('../server-tools');
const {packageRegistry} = require('./package-registry');

const logger = new Logger({module: 'route-app'});

module.exports.routeApp = (req, res) => {
  const appName = req.params.app;
  let rawTargetPath = req.params.path || req.params[0] || req.params.card || req.params['0'];
  if (Array.isArray(rawTargetPath)) {
    rawTargetPath = rawTargetPath.join('/');
  }
  const targetPath = (typeof rawTargetPath === 'string') ? rawTargetPath : '';

  logger.info(`request for app ${appName} path ${targetPath || '(main)'}`);

  if (appName === 'favicon.ico') {
    return res.sendFile(path.join(__dirname, 'assets', 'favicon.ico'));
  }

  if (targetPath === 'favicon.ico') {
    const pkg = packageRegistry[appName];
    if (pkg && pkg._path) {
      const localFavicon = path.join(pkg._path, 'favicon.ico');
      if (fs.existsSync(localFavicon) && fs.statSync(localFavicon).isFile()) {
        return res.sendFile(localFavicon);
      }
    }
    return res.sendFile(path.join(__dirname, 'assets', 'favicon.ico'));
  }

  logger.debug('packages are', Object.keys(packageRegistry));
  const package = packageRegistry[appName];
  logger.debug('package raw TOML is', package?._rawToml || package);
  if (!package) throw new HttpError(400, `package ${appName} not found`);
  const app = package.app;
  logger.debug('package.app', app);
  if (!app) throw new HttpError(400, `package ${appName} is not an app`);

  // 1. Determine relative path or card
  let subPath = targetPath;
  if (!subPath) {
    const cardId = app.main?.card || (package.cards && package.cards[0]?.id);
    if (!cardId) throw new HttpError(400, `no main card configured for ${appName}`);
    const card = (package.cards || []).find(c => c.id == cardId);
    if (!card) throw new HttpError(404, `card ${cardId} not found in package ${appName}`);
    subPath = card.path;
  } else {
    // Check if targetPath matches a card ID first (e.g. "main")
    const card = (package.cards || []).find(c => c.id == subPath);
    if (card) {
      subPath = card.path;
    }
  }

  // 2. Resolve target file path relative to package directory
  let filePath = subPath;
  if (!path.isAbsolute(filePath)) {
    filePath = path.join(package._path, filePath);
  }

  // Prevent directory traversal outside package._path
  const resolvedPackagePath = path.resolve(package._path);
  const resolvedFilePath = path.resolve(filePath);
  if (!resolvedFilePath.startsWith(resolvedPackagePath)) {
    throw new HttpError(403, `Access denied: path outside app directory`);
  }

  if (fs.existsSync(resolvedFilePath) && fs.statSync(resolvedFilePath).isFile()) {
    logger.info(`sending ${resolvedFilePath}`);
    return res.sendFile(resolvedFilePath);
  }

  throw new HttpError(404, `File or card '${targetPath}' not found in package ${appName}`);
};

module.exports.getApps = () => Object.fromEntries(
  Object.entries(packageRegistry).map(([appId, pkg]) => [
    appId,
    {
      name: pkg.app.name || appId,
      description: pkg.app.description || '',
      mainCard: pkg.app.main?.card || (pkg.cards && pkg.cards[0]?.id) || null,
      cards: (pkg.cards || []).map(card => card.id)
    }
  ])
);
