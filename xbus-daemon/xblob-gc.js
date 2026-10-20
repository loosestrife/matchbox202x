// xblob-gc.js for xbus-daemon
const { atoms, widString, XClientMessage } = require('../x11-promises/xintent.js');
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xblob-gc' });
const { X, rawX, routerWin } = require('./index.js');

const DEFAULT_MASK = 0x1fffff;
let mask;

const resourceMask = () => {
  if (mask === undefined) {
    mask = rawX?.display?.resource_mask || DEFAULT_MASK;
  }
  return mask;
};

const isXid = w => Number.isInteger(w) && w > 0 && w <= 0x1fffffff;
const xClientFor = wid => isXid(wid) ? (wid & ~resourceMask()) >>> 0 : null;

const sameClient = (a, b) => {
  const ca = xClientFor(a), cb = xClientFor(b);
  return ca != null && ca == cb;
};

const checkForDeletion = async (blobId, regEntry, xblobRegistry) => {
  if (regEntry.links.length === 0 && regEntry.softLinks.length === 0) {
    logger.info(`deleting unlinked blob ${widString(blobId)} from hosts`, regEntry.hosts);
    delete xblobRegistry[blobId];
  }
};

const notifyDestructors = (blobId, regEntry) => {
  const notifyTargets = new Set([...regEntry.softLinks, ...regEntry.hosts]);
  for (const notifyWin of notifyTargets) {
    if (notifyWin && notifyWin !== routerWin) {
      try {
        if (X && typeof X.SendEvent === 'function') {
          XClientMessage(X, notifyWin, atoms.XBLOB_DESTRUCTOR_V0, [
            routerWin,
            blobId,
          ]);
        }
      } catch (_) {}
    }
  }
};

module.exports = {
  resourceMask,
  sameClient,
  checkForDeletion,
  notifyDestructors,
};
