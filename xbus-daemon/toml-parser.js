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

function mergeAppMetadata(aggregate, appName, meta = {}, intents = {}, cardMeta = {}) {
  if (!appName) return;
  if (!aggregate.apps) aggregate.apps = {};
  const existing = aggregate.apps[appName] || {};
  const mergedIntents = { ...(existing.intents || {}), ...(intents || {}) };
  const name = (meta.name && meta.name !== appName) ? meta.name : (existing.name || meta.name || appName);
  const description = meta.description || existing.description || '';
  const mainCard = cardMeta.mainCard || meta.main?.card || existing.mainCard || null;
  const rawCards = cardMeta.cards || existing.cards || null;
  const cards = Array.isArray(rawCards)
    ? rawCards.map((c) => (typeof c === 'string' ? c : c?.id)).filter(Boolean)
    : null;
  const appEntry = { name };
  if (description) appEntry.description = description;
  if (mainCard) appEntry.mainCard = mainCard;
  if (cards && cards.length > 0) appEntry.cards = cards;
  if (Object.keys(mergedIntents).length > 0) appEntry.intents = mergedIntents;
  aggregate.apps[appName] = appEntry;
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
    mergeAppMetadata(
      aggregate,
      appName,
      matchboxToml.app || {},
      matchboxToml.intents || {},
      {
        mainCard: matchboxToml.app?.main?.card || (Array.isArray(matchboxToml.cards) ? matchboxToml.cards[0]?.id : null),
        cards: matchboxToml.cards,
      },
    );
    processAudioSection(aggregate, 'XAudioSink', matchboxToml.XAudioSink, appName, wid);
    processAudioSection(aggregate, 'XAudioSource', matchboxToml.XAudioSource, appName, wid);
  }
}

function collectLighterEntries(aggregate, lighterRegistry, lighterAudioRegistry, lighterPackageRegistry = {}) {
  for (const [intentName, entries] of Object.entries(lighterRegistry)) {
    for (const entry of entries) {
      const appName = entry.packageName || entry.package;
      addAppToIntent(aggregate, intentName, appName);
      mergeAppMetadata(
        aggregate,
        appName,
        { name: entry.name, description: entry.description },
        entry.intents || { [intentName]: true },
        { mainCard: entry.mainCard, cards: entry.cards },
      );
    }
  }
  for (const [pakName, entry] of Object.entries(lighterPackageRegistry)) {
    const pkg = entry.pkg || {};
    mergeAppMetadata(
      aggregate,
      pakName,
      { name: pkg.name, description: pkg.description },
      pkg.intents || {},
      { mainCard: pkg.mainCard, cards: pkg.cards },
    );
  }
  for (const [pakName, entry] of Object.entries(lighterAudioRegistry)) {
    processAudioSection(aggregate, 'XAudioSink', entry.pkg.XAudioSink, pakName, entry.wid);
    processAudioSection(aggregate, 'XAudioSource', entry.pkg.XAudioSource, pakName, entry.wid);
  }
}

async function updateAggregateToml({ windowRegistry, lighterRegistry, lighterAudioRegistry, lighterPackageRegistry }) {
  const aggregate = { intents: {}, apps: {} };
  collectLighterEntries(aggregate, lighterRegistry, lighterAudioRegistry, lighterPackageRegistry);
  collectWindowEntries(aggregate, windowRegistry);

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
