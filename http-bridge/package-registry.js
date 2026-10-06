const conf = require('./conf');
const fs = require('node:fs');
const path = require('node:path');
const TOML = require('@iarna/toml');

packageRegistry = {};

function registerPackage(tomlPath) {
  try {
    const rawContent = fs.readFileSync(tomlPath, 'utf-8');
    const parsed = TOML.parse(rawContent);
    const appId = parsed.app?.id;
    if (!appId) return;
    if (packageRegistry[appId]) {
      console.log(`dup app ${appId}`, packageRegistry[appId]._path, tomlPath);
      return;
    };
    parsed._path = path.dirname(tomlPath);
    packageRegistry[appId] = parsed;
  } catch (err) {
    console.error(`Failed to parse TOML at ${tomlPath}:`, err);
  }
}

function buildRegistries() {
  [packageRegistry].forEach(r =>
    Object.keys(r).forEach(k =>
      delete r[k]
    )
  );
  for(const packageDir of conf.packagePath.filter(fs.existsSync)){
    const entries = fs.readdirSync(packageDir, { withFileTypes: true });
    for (const entry of entries) {
      let entryTomlPath;
      const fullPath = path.join(packageDir, entry.name);
      if (entry.isDirectory()) {
        // Check for directory/matchbox.toml
        const indexPath = path.join(fullPath, 'matchbox.toml');
        if (fs.existsSync(indexPath)) {
          entryTomlPath = indexPath;
        }
      } else if (entry.isFile() && entry.name.endsWith('.toml')) {
        entryTomlPath = fullPath;
      }
      if(entryTomlPath){
        registerPackage(entryTomlPath)
      }
    }
  }
  console.log({packageRegistry});
}

buildRegistries();

module.exports = {packageRegistry, buildRegistries};