// toml-parser.js for xbus-daemon
const TOML = require('@iarna/toml');
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'toml-parser' });
const { atoms, widString } = require('../x11-promises/xintent');
const { X, root, routerWin, x11 } = require('./index');

function addAppToIntent(aggregate, intentName, appName) {
  if (!appName) return;
  if (!aggregate.intents[intentName]) {
    aggregate.intents[intentName] = [];
  }
  if (!aggregate.intents[intentName].includes(appName)) {
    aggregate.intents[intentName].push(appName);
  }
}

function recordAudioObjectEntry(sectionObj, item, appName, wid) {
  const sinkName = item.name || item.id;
  const widField = wid ? { wid: widString(wid) } : {};
  if (sinkName) {
    sectionObj[sinkName] = { app: appName, ...widField, ...item };
    return;
  }
  for (const [k, v] of Object.entries(item)) {
    sectionObj[k] = {
      app: appName,
      ...widField,
      ...(typeof v === 'object' ? v : { name: k, value: v }),
    };
  }
}

function processAudioSection(aggregate, sectionKey, item, appName, wid) {
  if (!item) return;
  if (!aggregate[sectionKey]) aggregate[sectionKey] = {};

  if (Array.isArray(item)) {
    item.forEach((sub) => processAudioSection(aggregate, sectionKey, sub, appName, wid));
    return;
  }
  if (typeof item === 'object') {
    recordAudioObjectEntry(aggregate[sectionKey], item, appName, wid);
  }
}

function collectWindowEntries(aggregate, windowRegistry) {
  for (const [widStr, matchboxToml] of Object.entries(windowRegistry)) {
    const wid = parseInt(widStr, 10);
    const appName = matchboxToml?.app?.id || `win-${wid}`;

    for (const intentName of Object.keys(matchboxToml.intents || {})) {
      addAppToIntent(aggregate, intentName, appName);
    }
    processAudioSection(aggregate, 'XAudioSink', matchboxToml.XAudioSink, appName, wid);
    processAudioSection(aggregate, 'XAudioSource', matchboxToml.XAudioSource, appName, wid);
  }
}

function collectLighterEntries(aggregate, lighterRegistry, lighterAudioRegistry) {
  for (const [intentName, entries] of Object.entries(lighterRegistry)) {
    for (const entry of entries) {
      addAppToIntent(aggregate, intentName, entry.packageName || entry.package);
    }
  }
  for (const [pakName, entry] of Object.entries(lighterAudioRegistry)) {
    processAudioSection(aggregate, 'XAudioSink', entry.pkg.XAudioSink, pakName, entry.wid);
    processAudioSection(aggregate, 'XAudioSource', entry.pkg.XAudioSource, pakName, entry.wid);
  }
}

async function updateAggregateToml({ windowRegistry, lighterRegistry, lighterAudioRegistry }) {
  const aggregate = { intents: {} };
  collectWindowEntries(aggregate, windowRegistry);
  collectLighterEntries(aggregate, lighterRegistry, lighterAudioRegistry);

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
      Buffer.from(tomlString, 'utf8'),
    );
    logger.info(`Updated aggregate digest raw TOML property on router window ${widString(routerWin)}:\n${tomlString}`);
  } catch (err) {
    logger.error('Failed to update aggregate TOML property:', err.message);
  }
}

async function getAllMatchboxToml({ parseWindowToml, parseWindowLighterToml, updateAggregateToml }) {
  const tree = await X.QueryTree(root);
  if (!tree || !tree.children) return;

  for (const wid of tree.children) {
    try {
      X.ChangeWindowAttributes(wid, { eventMask: x11.eventMask.PropertyChange });
    } catch (_) {}
    await parseWindowToml(wid);
    await parseWindowLighterToml(wid);
  }
  await updateAggregateToml();
}

module.exports = {
  updateAggregateToml,
  getAllMatchboxToml,
};
