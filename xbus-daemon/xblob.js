// xblob.js for xbus-daemon
const os = require('os');
const {atoms, widString, parseJsonFrame, XClientMessage} = require('../x11-promises/xintent.js');
const {Logger} = require('../server-tools');
const logger = new Logger({module: 'xblob'});
const {X, rawX, x11, root, routerWin} = require('./index.js');

const xblobRegistry = {};
let nextOpaqueBlobId = 0x100;

const handleXBlobCreateV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, cookie, typeAtom, initialHardLinker] = ev.data;
    return {targetWin, senderWin, cookie, typeAtom: typeAtom || 0, initialHardLinker: initialHardLinker || 0};
  },
  securityContext: parsed => {
    return {
      source: {window: parsed.senderWin},
      action: 'XBlobCreate',
      resources: [{typeAtom: parsed.typeAtom}],
    };
  },
  accept: async parsed => {
    const blobId = await xblobCreate(parsed.senderWin, null, parsed.typeAtom, parsed.initialHardLinker);
    logger.info(`XBlobCreate created ${widString(blobId)} (typeAtom: ${widString(parsed.typeAtom || 0)}) from ${widString(parsed.senderWin)}${parsed.initialHardLinker ? ` (hardLinker: ${widString(parsed.initialHardLinker)})` : ''}`);

    const responseEv = Buffer.alloc(32);
    responseEv.writeInt8(33, 0); // ClientMessage
    responseEv.writeInt8(32, 1); // 32-bit format
    responseEv.writeUInt32LE((parsed.senderWin || 0) >>> 0, 4);
    responseEv.writeUInt32LE((atoms.XBLOB_CREATE_RESPONSE_V0 || 0) >>> 0, 8);
    responseEv.writeUInt32LE((routerWin || 0) >>> 0, 12);        // data.l[0] = senderWin (router)
    responseEv.writeUInt32LE((blobId || 0) >>> 0, 16);           // data.l[1] = allocated blob ID
    responseEv.writeUInt32LE((parsed.cookie || 0) >>> 0, 20);    // data.l[2] = client cookie
    responseEv.writeUInt32LE((parsed.cookie || 0) >>> 0, 20);    // data.l[2] = client cookie

    await X.SendEvent(parsed.senderWin, false, x11.eventMask.NoEventMask, responseEv);
  },
};

const handleXBlobGrantV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, blobId, grantee] = ev.data;
    return {targetWin, senderWin, blobId, grantee};
  },
  securityContext: parsed => {
    return {
      source: {window: parsed.senderWin},
      action: 'XBlobGrant',
      resources: [{
        XBlob: parsed.blobId,
        exists: parsed.blobId in xblobRegistry,
        authorized: !!(xblobRegistry[parsed.blobId]?.links.filter(win => sameClient(parsed.senderWin, win)).length),
      }],
    };
  },
  accept: parsed => {
    logger.info(`XBlobGrant granting ${widString(parsed.blobId)} to ${widString(parsed.grantee)} from ${widString(parsed.senderWin)}`);
    implicitXBlobGrant(parsed.blobId, parsed.grantee);
  },
};

const handleXBlobUnlinkV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, blobId] = ev.data;
    return {targetWin, senderWin, blobId};
  },
  securityContext: parsed => {
    return {
      source: {window: parsed.senderWin},
      action: 'XBlobUnlink',
      resources: [{XBlob: parsed.blobId}],
    };
  },
  accept: async parsed => {
    logger.info(`XBlobUnlink unlinking ${widString(parsed.blobId)} from ${widString(parsed.senderWin)}`);
    await xblobUnlink(parsed.blobId, parsed.senderWin);
  },
};

const handleXBlobSoftLinkV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, blobId] = ev.data;
    return {targetWin, senderWin, blobId};
  },
  securityContext: parsed => {
    return {
      source: {window: parsed.senderWin},
      action: 'XBlobSoftLink',
      resources: [{XBlob: parsed.blobId}],
    };
  },
  accept: async ({senderWin, blobId}) => {
    logger.info(`XBlobSoftLink soft linking ${widString(blobId)} from ${widString(senderWin)}`);
    if (xblobRegistry[blobId]) {
      xblobRegistry[blobId].softLinks.push(senderWin);
    }
  },
};

const handleXBlobSoftUnlinkV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, blobId] = ev.data;
    return {targetWin, senderWin, blobId};
  },
  securityContext: ({senderWin, blobId}) => {
    return {
      source: {window: senderWin},
      action: 'XBlobSoftUnlink',
      resources: [{XBlob: blobId}],
    };
  },
  accept: async ({blobId, senderWin}) => {
    logger.info(`XBlobSoftUnlink soft unlinking ${widString(blobId)} from ${widString(senderWin)}`);
    if (xblobRegistry[blobId]) {
      const link = xblobRegistry[blobId].softLinks.indexOf(senderWin);
      if (link !== -1) {
        xblobRegistry[blobId].softLinks.splice(link, 1);
      }
      await checkForDeletion(blobId, xblobRegistry[blobId]);
    }
  },
};

const handleXBlobAnnounceHostV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, blobId, hostWin, typeAtom] = ev.data;
    return { targetWin, senderWin, blobId, host: hostWin || senderWin, typeAtom: typeAtom || 0 };
  },
  securityContext: parsed => {
    return {
      source: { window: parsed.senderWin },
      action: 'XBlobAnnounceHost',
      resources: [{ XBlob: parsed.blobId, typeAtom: parsed.typeAtom }],
    };
  },
  accept: async ({ blobId, host, typeAtom }) => {
    const regEntry = xblobRegistry[blobId];
    if (regEntry) {
      if (typeAtom && !regEntry.typeAtom) {
        regEntry.typeAtom = typeAtom;
      }
      if (host && !regEntry.hosts.includes(host)) {
        regEntry.hosts.push(host);
        logger.info(`XBlobAnnounceHost registered host ${widString(host)} (typeAtom: ${widString(regEntry.typeAtom || 0)}) for blob ${widString(blobId)}`);
      }
    }
  },
};

const handleXBlobDropHostV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, blobId, hostWin] = ev.data;
    return { targetWin, senderWin, blobId, host: hostWin || senderWin };
  },
  securityContext: parsed => {
    return {
      source: { window: parsed.senderWin },
      action: 'XBlobDropHost',
      resources: [{ XBlob: parsed.blobId }],
    };
  },
  accept: async ({ blobId, host }) => {
    const regEntry = xblobRegistry[blobId];
    if (regEntry && host) {
      const idx = regEntry.hosts.indexOf(host);
      if (idx !== -1) {
        regEntry.hosts.splice(idx, 1);
        logger.info(`XBlobDropHost dropped host ${widString(host)} from blob ${widString(blobId)}`);
      }
    }
  },
};

const handleXBlobBroadcastV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, blobId, host, version] = ev.data;
    return {targetWin, senderWin, blobId, host, version};
  },
  securityContext: parsed => {
    return {
      source: {window: parsed.senderWin},
      action: 'XBlobBroadcast',
      resources: [{XBlob: parsed.blobId}],
    };
  },
  accept: async ({senderWin, blobId, host, version}) => {
    logger.info(`XBlobBroadcast broadcasting version ${version} on host ${widString(host)} of ${widString(blobId)} from ${widString(senderWin)}`);
    if (xblobRegistry[blobId] && host) {
      if (!xblobRegistry[blobId].hosts.includes(host)) {
        xblobRegistry[blobId].hosts.push(host);
      }
    }
    for(const broadcastTarget of [
      ...(xblobRegistry[blobId]?.links || []),
      ...(xblobRegistry[blobId]?.softLinks || [])
    ]){
      if([senderWin, routerWin].includes(broadcastTarget)){
        continue;
      }
      try {
        if (X && typeof X.SendEvent === 'function') {
          XClientMessage(X, broadcastTarget, atoms.XBLOB_BROADCAST_V0, [
            senderWin,
            blobId,
            host,
            version,
          ]);
        }
      } catch (_) {}
    }
  },
};

const handleXBlobTransferV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, blobId, grantee] = ev.data;
    return { targetWin, senderWin, blobId, grantee };
  },
  securityContext: parsed => {
    return {
      source: { window: parsed.senderWin },
      action: 'XBlobTransfer',
      resources: [{
        XBlob: parsed.blobId,
        exists: parsed.blobId in xblobRegistry,
        authorized: !!(xblobRegistry[parsed.blobId]?.links.filter(win => sameClient(parsed.senderWin, win)).length),
      }],
    };
  },
  accept: async parsed => {
    logger.info(`XBlobTransfer transferring ${widString(parsed.blobId)} from ${widString(parsed.senderWin)} to ${widString(parsed.grantee)}`);
    await implicitXBlobTransfer(parsed.blobId, parsed.senderWin, parsed.grantee);
  },
};

const xblobCreate = async (senderWin, hostWin = null, typeAtom = 0, initialHardLinker = null) => {
  let initialHost = hostWin;
  if (!initialHost) {
    try {
      const hostname = os.hostname();
      const hostAtom = await X.InternAtom(false, `XBLOB_HOST_${hostname}`);
      initialHost = (await X.GetSelectionOwner(hostAtom)) || senderWin;
    } catch (_) {
      initialHost = senderWin;
    }
  }

  const primaryHardLinker = initialHardLinker || senderWin;
  const primaryHost = initialHardLinker ? senderWin : initialHost;

  const blobTrackingData = {
    typeAtom: typeAtom || 0,
    links: [primaryHardLinker],
    softLinks: primaryHost && primaryHost !== primaryHardLinker ? [primaryHost] : [],
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

const xblobUnlink = async (blobId, unlinkWin) => {
  const regEntry = xblobRegistry[blobId];
  if (!regEntry) {
    logger.warn(`xblobUnlink: no such blob ${widString(blobId)}`);
    return;
  }
  let link = regEntry.links.indexOf(unlinkWin);
  if (link === -1 && unlinkWin) {
    const cMask = ~resourceMask();
    link = regEntry.links.findIndex(w => w && (w & cMask) === (unlinkWin & cMask));
  }

  if (link === -1) {
    logger.warn(`Attempt to unlink blob ${widString(blobId)} from window ${widString(unlinkWin)} which isn't linked`, xblobRegistry);
  } else {
    regEntry.links.splice(link, 1);
  }

  if (regEntry.links.length === 0) {
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
  }

  await checkForDeletion(blobId, regEntry);
};

const checkForDeletion = async (blobId, regEntry) => {
  if (regEntry.links.length === 0 && regEntry.softLinks.length === 0) {
    logger.info(`deleting unlinked blob ${widString(blobId)} from hosts`, regEntry.hosts);
    delete xblobRegistry[blobId];
  }
};

const implicitXBlobTransfer = async (blobId, fromWin, toWin) => {
  implicitXBlobGrant(blobId, toWin);
  await xblobUnlink(blobId, fromWin);
};

// Modern Xorg hands out 21-bit masks (IDs like 0x3a00003 with base 0x3a00000).
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

const xblobUnlinkWindow = async (destroyedWin) => {
  const blobIds = Object.keys(xblobRegistry);
  for (const blobIdStr of blobIds) {
    const blobId = Number(blobIdStr);
    const regEntry = xblobRegistry[blobId];

    if (regEntry?.links) {
      while (regEntry.links.includes(destroyedWin)) {
        await xblobUnlink(blobId, destroyedWin);
      }
    }
  }
};

module.exports = {
  xblobRegistry,
  handleXBlobCreateV0,
  handleXBlobGrantV0,
  handleXBlobUnlinkV0,
  handleXBlobTransferV0,
  handleXBlobBroadcastV0,
  handleXBlobSoftLinkV0,
  handleXBlobSoftUnlinkV0,
  handleXBlobAnnounceHostV0,
  handleXBlobDropHostV0,
  xblobCreate,
  implicitXBlobGrant,
  implicitXBlobTransfer,
  xblobUnlink,
  xblobUnlinkWindow,
};
