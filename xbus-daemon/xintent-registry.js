// xintent-registry.js for xbus-daemon
const TOML = require("@iarna/toml");
const { Logger } = require("../server-tools");
const logger = new Logger({ module: "xintent-registry" });
const { atoms, widString } = require("../x11-promises/xintent");
const { X } = require("./index");
const { updateAggregateToml, getAllMatchboxToml: getAllToml } = require("./toml-parser");

const intentRegistry = {};      // intent -> [{ wid, matchboxToml }]
const lighterRegistry = {};     // intent -> [{ wid, computer, packageName, publicKeyHash }]
const windowRegistry = {};      // wid -> matchboxToml
const lighterAudioRegistry = {};// packageName -> { wid, computer, pkg }
const lighterPackageRegistry = {}; // packageName -> { wid, computer, pkg }

let checkToDrainIntentsQueue;

async function doUpdateAggregateToml() {
  await updateAggregateToml({ windowRegistry, lighterRegistry, lighterAudioRegistry, lighterPackageRegistry });
}

async function getAllMatchboxToml() {
  await getAllToml({
    parseWindowToml,
    parseWindowLighterToml,
    updateAggregateToml: doUpdateAggregateToml,
  });
}

async function parseWindowToml(wid) {
  try {
    const propertyAtom = atoms.MATCHBOX_TOML || await X.InternAtom(false, 'MATCHBOX_TOML');
    const prop = await X.GetProperty(
      0,
      wid,
      propertyAtom,
      0,
      0,
      1000000,
    );
    if (prop && prop.data && prop.data.length > 0) {
      const rawToml = prop.data.toString("utf8");
      const matchboxToml = TOML.parse(rawToml);
      windowRegistry[wid] = matchboxToml;
      logger.info(`Discovered service window ${widString(wid)} (${matchboxToml.app?.id || 'service'}) raw TOML:\n${rawToml}`);
      let updated = false;

      if (matchboxToml.intents) {
        for (const intentName of Object.keys(matchboxToml.intents)) {
          if (!intentRegistry[intentName]) intentRegistry[intentName] = [];

          if (!intentRegistry[intentName].some((entry) => entry.wid === wid)) {
            intentRegistry[intentName].push({ wid, matchboxToml });
            if (typeof checkToDrainIntentsQueue === 'function') {
              checkToDrainIntentsQueue(intentName);
            }
            logger.info(
              `Registered intent '${intentName}' -> Window ${widString(wid)}`,
            );
            updated = true;
          }
        }
      }

      if (matchboxToml.XAudioSink || matchboxToml.XAudioSource) {
        updated = true;
      }

      if (updated) {
        await doUpdateAggregateToml();
      }
    }
  } catch (err) {
    if (err?.message?.toLowerCase().includes("bad window") || err?.message?.toLowerCase().includes("badwindow")) {
      return;
    }
    logger.error(
      `Failed parsing TOML on window ${widString(wid)}:`,
      err.message,
    );
  }
}

async function parseWindowLighterToml(wid) {
  try {
    const manifestAtom = atoms.SERVICE_MANIFEST_TOML || await X.InternAtom(false, 'SERVICE_MANIFEST_TOML');
    const prop = await X.GetProperty(
      0,
      wid,
      manifestAtom,
      0,
      0,
      1000000,
    );
    if (!prop || !prop.data || prop.data.length === 0) {
      return;
    }
    const rawToml = prop.data.toString("utf8");
    const toml = TOML.parse(rawToml);
    logger.info(
      "got SERVICE_MANIFEST_TOML from window",
      widString(wid),
      rawToml,
    );
    const computer = toml.computer;
    let updated = false;

    for (const packageName of Object.keys(toml.packages || {})) {
      const pkg = toml.packages[packageName];
      const publicKeyHash = pkg.publicKeyHash;
      lighterPackageRegistry[packageName] = { wid, computer, pkg };
      updated = true;

      if (pkg.intents) {
        for (const intentName of Object.keys(pkg.intents)) {
          if (!lighterRegistry[intentName]) lighterRegistry[intentName] = [];
          if (!lighterRegistry[intentName].some(e => e.wid === wid && e.packageName === packageName)) {
            lighterRegistry[intentName].push({
              wid,
              computer,
              packageName,
              name: pkg.name,
              description: pkg.description,
              mainCard: pkg.mainCard,
              cards: pkg.cards,
              intents: pkg.intents,
              publicKeyHash,
            });
            updated = true;
          }
        }
      }

      if (pkg.XAudioSink || pkg.XAudioSource) {
        lighterAudioRegistry[packageName] = { wid, computer, pkg };
        updated = true;
      }
    }
    if (updated) {
      await doUpdateAggregateToml();
    }
  } catch (err) {
    if (err?.message?.toLowerCase().includes("bad window") || err?.message?.toLowerCase().includes("badwindow")) {
      return;
    }
    logger.error(
      `Failed parsing lighter TOML on window ${widString(wid)}:`,
      err.message,
    );
  }
}

function unregisterWindowRegistry(destroyedWin) {
  let registryChanged = false;

  if (windowRegistry[destroyedWin]) {
    delete windowRegistry[destroyedWin];
    registryChanged = true;
  }

  for (const [intentName, entries] of Object.entries(intentRegistry)) {
    const origLen = entries.length;
    intentRegistry[intentName] = entries.filter(e => e.wid !== destroyedWin);
    if (intentRegistry[intentName].length === 0) {
      delete intentRegistry[intentName];
    }
    if ((intentRegistry[intentName]?.length || 0) !== origLen) {
      registryChanged = true;
    }
  }

  for (const [pkgName, entry] of Object.entries(lighterAudioRegistry)) {
    if (entry.wid === destroyedWin) {
      delete lighterAudioRegistry[pkgName];
      registryChanged = true;
    }
  }

  return registryChanged;
}

module.exports = {
  intentRegistry,
  lighterRegistry,
  windowRegistry,
  lighterAudioRegistry,
  getAllMatchboxToml,
  parseWindowToml,
  parseWindowLighterToml,
  updateAggregateToml: doUpdateAggregateToml,
  unregisterWindowRegistry,
  initXIntentRegistry: ({checkToDrainIntentsQueue: fn}) => {
    checkToDrainIntentsQueue = fn;
  },
};
