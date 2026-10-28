const path = require('path');
const fs = require('fs');
const { Logger, HttpError } = require('../server-tools');
const { packageRegistry } = require('./package-registry');

const logger = new Logger({ module: 'route-app' });

function normalizeTargetPath(params) {
  const raw = params.path || params[0] || params.card || params['0'];
  if (Array.isArray(raw)) return raw.join('/');
  return typeof raw === 'string' ? raw : '';
}

function tryServeFavicon(res, appName, targetPath) {
  if (appName === 'favicon.ico') {
    res.sendFile(path.join(__dirname, 'assets', 'favicon.ico'));
    return true;
  }
  if (targetPath !== 'favicon.ico') return false;

  const pkg = packageRegistry[appName];
  const localFavicon = pkg?._path ? path.join(pkg._path, 'favicon.ico') : null;
  if (localFavicon && fs.existsSync(localFavicon) && fs.statSync(localFavicon).isFile()) {
    res.sendFile(localFavicon);
    return true;
  }
  res.sendFile(path.join(__dirname, 'assets', 'favicon.ico'));
  return true;
}

function findPackageByAppName(appName) {
  if (packageRegistry[appName]) return packageRegistry[appName];
  const strippedApp = appName.replace(/s$/, '');
  return Object.values(packageRegistry).find((p) => {
    const base = path.basename(p._path);
    return p.app?.id === appName || base === appName || base.replace(/s$/, '') === strippedApp;
  });
}

function resolveAppSubPath(pkg, appName, targetPath) {
  const cards = pkg.cards || [];
  if (!targetPath) {
    const cardId = pkg.app.main?.card || cards[0]?.id;
    if (!cardId) throw new HttpError(400, `no main card configured for ${appName}`);
    const card = cards.find((c) => c.id == cardId);
    if (!card) throw new HttpError(404, `card ${cardId} not found in package ${appName}`);
    return card.path;
  }
  const matchedCard = cards.find((c) => c.id == targetPath);
  return matchedCard ? matchedCard.path : targetPath;
}

module.exports.routeApp = (req, res) => {
  const appName = req.params.app;
  const targetPath = normalizeTargetPath(req.params);

  logger.info(`request for app ${appName} path ${targetPath || '(main)'}`);
  if (tryServeFavicon(res, appName, targetPath)) return;

  logger.debug('packages are', Object.keys(packageRegistry));
  const pkg = findPackageByAppName(appName);
  logger.debug('package raw TOML is', pkg?._rawToml || pkg);
  if (!pkg) throw new HttpError(400, `package ${appName} not found`);
  logger.debug('package.app', pkg.app);
  if (!pkg.app) throw new HttpError(400, `package ${appName} is not an app`);

  const subPath = resolveAppSubPath(pkg, appName, targetPath);
  const filePath = path.isAbsolute(subPath) ? subPath : path.join(pkg._path, subPath);

  const resolvedPackagePath = path.resolve(pkg._path);
  const resolvedFilePath = path.resolve(filePath);
  if (!resolvedFilePath.startsWith(resolvedPackagePath)) {
    throw new HttpError(403, 'Access denied: path outside app directory');
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
      cards: (pkg.cards || []).map((card) => card.id),
    },
  ])
);
