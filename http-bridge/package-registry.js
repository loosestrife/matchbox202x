const conf = require('./conf');
const fs = require('node:fs');
const path = require('node:path');
const TOML = require('@iarna/toml');

intentRegistry = {};
packageRegistry = {};

function registerPackage(tomlPath) {
  try {
    const rawContent = fs.readFileSync(tomlPath, 'utf-8');
    const parsed = TOML.parse(rawContent);
    const packageId = parsed.package?.id;
    if (!packageId) return;
    if (packageRegistry[packageId]) {
      console.log(`dup package ${packageId}`, packageRegistry.packageId._path, tomlPath);
      return;
    };
    parsed._path = path.dirname(tomlPath);
    packageRegistry[packageId] = parsed;
    if (parsed.intents) {
      for(const intentName of Object.keys(parsed.intents)){
        if (!intentRegistry[intentName]) {
          intentRegistry[intentName] = [];
        }
        if (!intentRegistry[intentName].includes(packageId)) {
          intentRegistry[intentName].push(packageId);
        }
      }        
    }
  } catch (err) {
    console.error(`Failed to parse TOML at ${tomlPath}:`, err);
  }
}

function buildRegistries() {
  [intentRegistry, packageRegistry].forEach(r =>
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
  console.log({intentRegistry, packageRegistry});
}

buildRegistries();

module.exports = {intentRegistry, packageRegistry, buildRegistries};