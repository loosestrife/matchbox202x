const TOML = require("@iarna/toml");
const { Logger } = require("../server-tools");
const logger = new Logger({ module: "xintent-registry" });
const { atoms, widString } = require("../x11-promises/xintent");
const { X, root, routerWin } = require("./index");

const intentRegistry = {};      // intent -> [{ wid, matchboxToml }]
const lighterRegistry = {};     // intent -> [{ wid, computer, packageName, publicKeyHash }]
const windowRegistry = {};      // wid -> matchboxToml
const lighterAudioRegistry = {};// packageName -> { wid, computer, pkg }

async function updateAggregateToml() {
  const aggregate = { intents: {} };

  const addAppToIntent = (intentName, appName) => {
    if (!appName) return;
    if (!aggregate.intents[intentName]) {
      aggregate.intents[intentName] = [];
    }
    if (!aggregate.intents[intentName].includes(appName)) {
      aggregate.intents[intentName].push(appName);
    }
  };

  const processAudioSection = (sectionKey, item, appName, wid) => {
    if (!item) return;
    if (!aggregate[sectionKey]) aggregate[sectionKey] = {};

    if (Array.isArray(item)) {
      item.forEach(sub => processAudioSection(sectionKey, sub, appName, wid));
      return;
    }

    if (typeof item === 'object') {
      const sinkName = item.name || item.id;
      if (sinkName) {
        aggregate[sectionKey][sinkName] = {
          app: appName,
          ...(wid ? { wid: widString(wid) } : {}),
          ...item
        };
      } else {
        for (const [k, v] of Object.entries(item)) {
          aggregate[sectionKey][k] = {
            app: appName,
            ...(wid ? { wid: widString(wid) } : {}),
            ...(typeof v === 'object' ? v : { name: k, value: v })
          };
        }
      }
    }
  };

  // 1. Aggregate active running intent handlers & audio endpoints
  for (const [widStr, matchboxToml] of Object.entries(windowRegistry)) {
    const wid = parseInt(widStr, 10);
    const appName = matchboxToml?.app?.id || `win-${wid}`;

    if (matchboxToml.intents) {
      for (const intentName of Object.keys(matchboxToml.intents)) {
        addAppToIntent(intentName, appName);
      }
    }

    if (matchboxToml.XAudioSink) {
      processAudioSection("XAudioSink", matchboxToml.XAudioSink, appName, wid);
    }
    if (matchboxToml.XAudioSource) {
      processAudioSection("XAudioSource", matchboxToml.XAudioSource, appName, wid);
    }
  }

  // 2. Aggregate launchable intent handlers from lighterRegistry
  for (const [intentName, entries] of Object.entries(lighterRegistry)) {
    for (const entry of entries) {
      const appName = entry.packageName || entry.package;
      addAppToIntent(intentName, appName);
    }
  }

  // 3. Aggregate audio endpoints declared in service lighter manifestos
  for (const [pakName, entry] of Object.entries(lighterAudioRegistry)) {
    const pkg = entry.pkg;
    if (pkg.XAudioSink) {
      processAudioSection("XAudioSink", pkg.XAudioSink, pakName, entry.wid);
    }
    if (pkg.XAudioSource) {
      processAudioSection("XAudioSource", pkg.XAudioSource, pakName, entry.wid);
    }
  }

  const aggregateAtom = atoms.XINTENT_AGGREGATE_TOML || atoms.AGGREGATE_TOML;
  if (!aggregateAtom || !routerWin) return;

  try {
    const tomlString = TOML.stringify(aggregate);
    await X.ChangeProperty(
      0,
      routerWin,
      aggregateAtom,
      atoms.STRING,
      8,
      Buffer.from(tomlString, "utf8"),
    );
    logger.info(`Updated aggregate digest TOML property on router window ${widString(routerWin)}`);
  } catch (err) {
    logger.error("Failed to update aggregate TOML property:", err.message);
  }
}

async function getAllMatchboxToml() {
  const tree = await X.QueryTree(root);
  for (const wid of tree.children) {
    await parseWindowToml(wid);
    await parseWindowLighterToml(wid);
  }
  await updateAggregateToml();
}

async function parseWindowToml(wid) {
  try {
    const propertyAtom = atoms.XINTENT_MATCHBOX_TOML || atoms.MATCHBOX_TOML;
    const prop = await X.GetProperty(
      0,
      wid,
      propertyAtom,
      0,
      0,
      1000000,
    );
    if (prop && prop.data && prop.data.length > 0) {
      const matchboxToml = TOML.parse(prop.data.toString("utf8"));
      windowRegistry[wid] = matchboxToml;
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
        await updateAggregateToml();
      }
    }
  } catch (err) {
    logger.error(
      `Failed parsing TOML on window ${widString(wid)}:`,
      err.message,
    );
  }
}

async function parseWindowLighterToml(wid) {
  try {
    const prop = await X.GetProperty(
      0,
      wid,
      atoms.XINTENT_SERVICES_MANIFEST,
      atoms.STRING,
      0,
      1000000,
    );
    if (prop && prop.data && prop.data.length > 0) {
      const toml = TOML.parse(prop.data.toString("utf8"));
      logger.info(
        "got XINTENT_SERVICES_MANIFEST from window",
        widString(wid),
        toml,
      );
      const computer = toml.computer;
      let updated = false;

      for (const packageName of Object.keys(toml.packages || {})) {
        const pkg = toml.packages[packageName];
        const publicKeyHash = pkg.publicKeyHash;

        if (pkg.intents) {
          for (const intentName of Object.keys(pkg.intents)) {
            if (!lighterRegistry[intentName]) lighterRegistry[intentName] = [];
            lighterRegistry[intentName].push({
              wid,
              computer,
              packageName,
              publicKeyHash,
            });
            updated = true;
          }
        }

        if (pkg.XAudioSink || pkg.XAudioSource) {
          lighterAudioRegistry[packageName] = { wid, computer, pkg };
          updated = true;
        }
      }
      if (updated) {
        await updateAggregateToml();
      }
    }
  } catch (err) {
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

  for (const [pkgName, entry] of Object.entries(lighterAudioRegistry)) {
    if (entry.wid === destroyedWin) {
      delete lighterAudioRegistry[pkgName];
      registryChanged = true;
    }
  }

  return registryChanged;
}

let checkToDrainIntentsQueue;
module.exports = {
  intentRegistry,
  lighterRegistry,
  windowRegistry,
  getAllMatchboxToml,
  parseWindowToml,
  parseWindowLighterToml,
  updateAggregateToml,
  unregisterWindowRegistry,
  initXIntentRegistry: ({checkToDrainIntentsQueue: fn}) => {
    checkToDrainIntentsQueue = fn;
  },
};
