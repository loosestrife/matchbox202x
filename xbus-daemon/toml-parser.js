// toml-parser.js for xbus-daemon
const TOML = require("@iarna/toml");
const { Logger } = require("../server-tools");
const logger = new Logger({ module: "toml-parser" });
const { atoms, widString } = require("../x11-promises/xintent");
const { X, root, routerWin, x11 } = require("./index");

async function updateAggregateToml({ windowRegistry, lighterRegistry, lighterAudioRegistry }) {
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

  const aggregateAtom = atoms.AGGREGATE_TOML || atoms.XINTENT_AGGREGATE_TOML;
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
    logger.info(`Updated aggregate digest raw TOML property on router window ${widString(routerWin)}:\n${tomlString}`);
  } catch (err) {
    logger.error("Failed to update aggregate TOML property:", err.message);
  }
}

async function getAllMatchboxToml({ parseWindowToml, parseWindowLighterToml, updateAggregateToml }) {
  const tree = await X.QueryTree(root);
  if (tree && tree.children) {
    for (const wid of tree.children) {
      try {
        X.ChangeWindowAttributes(wid, { eventMask: x11.eventMask.PropertyChange });
      } catch (_) {}
      await parseWindowToml(wid);
      await parseWindowLighterToml(wid);
    }
    await updateAggregateToml();
  }
}

module.exports = {
  updateAggregateToml,
  getAllMatchboxToml,
};
