const conf = require('./conf');
const fs = require('node:fs');
const path = require('node:path');
const TOML = require('@iarna/toml');
const { Logger } = require('../server-tools');

const logger = new Logger({ module: 'package-registry' });
const packageRegistry = {};

function isHtmlCardApp(parsed) {
  if (!parsed || !parsed.app || !parsed.app.id) {
    return false;
  }
  const hasCards = Array.isArray(parsed.cards) && parsed.cards.length > 0;
  const isHtmlMain = parsed.app.main?.type === 'html';
  return hasCards || isHtmlMain;
}

function registerPackage(tomlPath) {
  try {
    const rawContent = fs.readFileSync(tomlPath, 'utf-8');
    const parsed = TOML.parse(rawContent);
    if (!isHtmlCardApp(parsed)) return;

    const appId = parsed.app.id;
    if (packageRegistry[appId]) {
      logger.warn(`Duplicate app ${appId}`, packageRegistry[appId]._path, tomlPath);
      return;
    }
    parsed._path = path.dirname(tomlPath);
    packageRegistry[appId] = parsed;
  } catch (err) {
    logger.error(`Failed to parse TOML at ${tomlPath}:`, err.message);
  }
}

function buildRegistries() {
  Object.keys(packageRegistry).forEach(k => delete packageRegistry[k]);

  for (const packageDir of conf.packagePath.filter(fs.existsSync)) {
    const entries = fs.readdirSync(packageDir, { withFileTypes: true });
    for (const entry of entries) {
      let entryTomlPath;
      const fullPath = path.join(packageDir, entry.name);
      if (entry.isDirectory()) {
        const indexPath = path.join(fullPath, 'matchbox.toml');
        if (fs.existsSync(indexPath)) {
          entryTomlPath = indexPath;
        }
      } else if (entry.isFile() && entry.name.endsWith('.toml')) {
        entryTomlPath = fullPath;
      }
      if (entryTomlPath) {
        registerPackage(entryTomlPath);
      }
    }
  }
  logger.info('Loaded HTML card app packages:', Object.keys(packageRegistry));
}

buildRegistries();

module.exports = { packageRegistry, buildRegistries };
