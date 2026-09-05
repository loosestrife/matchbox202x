const fs = require('node:fs');
const os = require('os');
const path = require('node:path');
const TOML = require('@iarna/toml');

const MATCHBOX_PATH = [
  '~/.local/share/matchbox/packages',
  __dirname.split('/').slice(0,-2).join('/'),
];

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
  console.log('rebuilding package registry with path', MATCHBOX_PATH);
  [intentRegistry, packageRegistry].forEach(r =>
    Object.keys(r).forEach(k =>
      delete r[k]
    )
  );
  for(const packageDir of MATCHBOX_PATH.filter(fs.existsSync)){
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
const xintentServicesManifesto = {};
function genServicesManifesto() {
  xintentServicesManifesto.computer = {
    host: os.hostname(),
    user: os.userInfo().username,
  };
  xintentServicesManifesto.packages = {};
  for(const pakName in packageRegistry){
    const pak = packageRegistry[pakName];
    if(!pak.intents){
      continue;
    }
    xintentServicesManifesto.packages[pakName] = {
      publicKeyHash: '0xdeadbeef',
      intents: {},
    }
    for(const intent in pak.intents){
      xintentServicesManifesto.packages[pakName].intents[intent] = pak.intents[intent];
    }
  }
}
genServicesManifesto();
xintentServicesManifesto.packages["cool-tts"].intents["ui.TextToSpeech"] = {
  invocation: "X11",
  execDir: __dirname,
  exec: "bun cool-tts-mock.js",
  env: {},
  args: [],
};

module.exports = {intentRegistry, packageRegistry, buildRegistries, xintentServicesManifesto};