const TOML = require("@iarna/toml");
const { Logger } = require("../server-tools");
const logger = new Logger({ module: "xintent-registry" });
const { atoms, widString } = require("../x11-promises/xintent");
const { X, root, routerWin } = require("./index");

const intentRegistry = {};      // intent -> [{ wid, matchboxToml }]
const lighterRegistry = {};     // intent -> [{ wid, computer, packageName, publicKeyHash }]

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

  // 1. Aggregate active running intent handlers
  for (const [intentName, entries] of Object.entries(intentRegistry)) {
    for (const entry of entries) {
      const { matchboxToml, wid } = entry;
      const appName =
        matchboxToml?.app?.id ||
        `win-${wid}`;
      addAppToIntent(intentName, appName);
    }
  }

  // 2. Aggregate launchable intent handlers from lighterRegistry
  for (const [intentName, entries] of Object.entries(lighterRegistry)) {
    for (const entry of entries) {
      const appName = entry.packageName || entry.package;
      addAppToIntent(intentName, appName);
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
    const prop = await X.GetProperty(
      0,
      wid,
      atoms.XINTENT_MATCHBOX_TOML,
      0,
      0,
      1000000,
    );
    if (prop && prop.data && prop.data.length > 0) {
      const matchboxToml = TOML.parse(prop.data.toString("utf8"));
      let updated = false;
      if (matchboxToml.intents) {
        for (const intentName of Object.keys(matchboxToml.intents)) {
          if (!intentRegistry[intentName]) intentRegistry[intentName] = [];

          // Avoid duplicate bindings for the same window
          if (!intentRegistry[intentName].some((entry) => entry.wid === wid)) {
            intentRegistry[intentName].push({ wid, matchboxToml });
            checkToDrainIntentsQueue(intentName);
            logger.info(
              `Registered intent '${intentName}' -> Window ${widString(wid)}`,
            );
            updated = true;
          }
        }
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

      for (const packageName of Object.keys(toml.packages)) {
        const publicKeyHash = toml.packages[packageName].publicKeyHash;
        for (const intentName of Object.keys(
          toml.packages[packageName].intents,
        )) {
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

let checkToDrainIntentsQueue;
module.exports = {
  intentRegistry,
  lighterRegistry,
  getAllMatchboxToml,
  parseWindowToml,
  parseWindowLighterToml,
  updateAggregateToml,
  initXIntentRegistry: ({checkToDrainIntentsQueue: fn}) => {
    checkToDrainIntentsQueue = fn;
  },
};