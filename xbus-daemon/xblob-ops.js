// xblob-ops.js for xbus-daemon
const os = require('os');
const xintent = require('../x11-promises/xintent.js');
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xblob' });
const daemon = require('./index.js');
const gc = require('./xblob-gc.js');

const xblobRegistry = {};
let nextOpaqueBlobId = 0x100;

async function resolveDefaultHost(senderWin) {
  try {
    const hostname = os.hostname();
    const hostAtom = await daemon.X.InternAtom(false, `XBLOB_HOST_${hostname}`);
    return (await daemon.X.GetSelectionOwner(hostAtom)) || senderWin;
  } catch (_) {
    return senderWin;
  }
}

const xblobCreate = async (senderWin, hostWin = null, typeAtom = 0, initialHardLinker = null) => {
  const initialHost = hostWin || (await resolveDefaultHost(senderWin));
  const primaryHardLinker = initialHardLinker || senderWin;
  const primaryHost = initialHardLinker ? senderWin : initialHost;

  const linksList = [primaryHardLinker];
  if (senderWin && !linksList.includes(senderWin)) {
    linksList.push(senderWin);
  }

  const shouldSoftLinkHost = Boolean(
    primaryHost && primaryHost !== primaryHardLinker && !linksList.includes(primaryHost)
  );
  const blobTrackingData = {
    typeAtom: typeAtom || 0,
    links: linksList,
    softLinks: shouldSoftLinkHost ? [primaryHost] : [],
    hosts: primaryHost ? [primaryHost] : [],
  };

  const blobId = nextOpaqueBlobId++;
  xblobRegistry[blobId] = blobTrackingData;
  return blobId;
};

const implicitXBlobGrant = (blobId, grantee) => {
  if (xblobRegistry[blobId]) {
    xblobRegistry[blobId].links.push(grantee);
  }
};

function findLinkIndex(links, unlinkWin) {
  const exactIdx = links.indexOf(unlinkWin);
  if (exactIdx !== -1 || !unlinkWin) return exactIdx;
  const cMask = ~gc.resourceMask();
  return links.findIndex((w) => w && (w & cMask) === (unlinkWin & cMask));
}

const xblobUnlink = async (blobId, unlinkWin) => {
  const regEntry = xblobRegistry[blobId];
  if (!regEntry) {
    logger.warn(`xblobUnlink: no such blob ${xintent.widString(blobId)}`);
    return;
  }

  const link = findLinkIndex(regEntry.links, unlinkWin);
  if (link === -1) {
    logger.debug(`xblobUnlink: window ${xintent.widString(unlinkWin)} was not in hard links for blob ${xintent.widString(blobId)}`);
  } else {
    regEntry.links.splice(link, 1);
  }

  if (regEntry.links.length === 0) {
    gc.notifyDestructors(blobId, regEntry);
  }

  await gc.checkForDeletion(blobId, regEntry, xblobRegistry);
};

const implicitXBlobTransfer = async (blobId, fromWin, toWin) => {
  implicitXBlobGrant(blobId, toWin);
  await xblobUnlink(blobId, fromWin);
};

const xblobUnlinkWindow = async (destroyedWin) => {
  const blobIds = Object.keys(xblobRegistry);
  for (const blobIdStr of blobIds) {
    const blobId = Number(blobIdStr);
    const regEntry = xblobRegistry[blobId];
    if (!regEntry?.links) continue;
    while (regEntry.links.includes(destroyedWin)) {
      await xblobUnlink(blobId, destroyedWin);
    }
  }
};

module.exports = {
  xblobRegistry,
  xblobCreate,
  implicitXBlobGrant,
  xblobUnlink,
  implicitXBlobTransfer,
  xblobUnlinkWindow,
};
