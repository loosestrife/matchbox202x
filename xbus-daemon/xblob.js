// xblob.js for xbus-daemon
const os = require('os');
const {atoms, widString, parseJsonFrame, XClientMessage} = require('../x11-promises/xintent.js');
const {Logger} = require('../server-tools');
const logger = new Logger({module: 'xblob'});
const {X, x11, routerWin} = require('./index.js');
const { sameClient, resourceMask, checkForDeletion, notifyDestructors } = require('./xblob-gc.js');

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
      await checkForDeletion(blobId, xblobRegistry[blobId], xblobRegistry);
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

const connectedHosts = new Map();

const handleXBlobHostConnectV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const senderWin = ev.data[0];
    const hostWin = ev.data[1] || senderWin;
    const socketPathAtom = ev.data[2];
    const hostNameAtom = ev.data[3];
    return { targetWin, senderWin, hostWin, socketPathAtom, hostNameAtom };
  },
  securityContext: parsed => {
    return {
      source: { window: parsed.senderWin },
      action: 'XBlobHostConnect',
      resources: [],
    };
  },
  accept: async ({ senderWin, hostWin, socketPathAtom, hostNameAtom }, X) => {
    const { windowRegistry } = require('./xintent-registry');
    let socketPath = 'unknown';
    if (socketPathAtom && X) {
      try {
        const prop = await X.GetProperty(0, hostWin, socketPathAtom, 0, 0, 1000);
        if (prop && prop.data) socketPath = prop.data.toString('utf8');
      } catch (_) {}
    }
    const tomlHost = windowRegistry[senderWin]?.XBlobHost?.host;
    let hostName = tomlHost || 'unknown';
    if (hostNameAtom && X) {
      try {
        const atomName = await X.GetAtomName(hostNameAtom);
        if (atomName) hostName = atomName;
      } catch (_) {}
    }
    connectedHosts.set(senderWin, { hostName, hostWin, socketPath, connectedAt: new Date() });
    logger.info(`XBlobHostConnect registered secondary host '${hostName}' (${widString(hostWin)}, socket: ${socketPath})`);
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

  const linksList = [primaryHardLinker];
  if (senderWin && !linksList.includes(senderWin)) {
    linksList.push(senderWin);
  }

  const blobTrackingData = {
    typeAtom: typeAtom || 0,
    links: linksList,
    softLinks: primaryHost && primaryHost !== primaryHardLinker && !linksList.includes(primaryHost) ? [primaryHost] : [],
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
    logger.debug(`xblobUnlink: window ${widString(unlinkWin)} was not in hard links for blob ${widString(blobId)}`);
  } else {
    regEntry.links.splice(link, 1);
  }

  if (regEntry.links.length === 0) {
    notifyDestructors(blobId, regEntry);
  }

  await checkForDeletion(blobId, regEntry, xblobRegistry);
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

    if (regEntry?.links) {
      while (regEntry.links.includes(destroyedWin)) {
        await xblobUnlink(blobId, destroyedWin);
      }
    }
  }
};

module.exports = {
  xblobRegistry,
  connectedHosts,
  handleXBlobCreateV0,
  handleXBlobGrantV0,
  handleXBlobUnlinkV0,
  handleXBlobTransferV0,
  handleXBlobBroadcastV0,
  handleXBlobSoftLinkV0,
  handleXBlobSoftUnlinkV0,
  handleXBlobAnnounceHostV0,
  handleXBlobDropHostV0,
  handleXBlobHostConnectV0,
  xblobCreate,
  implicitXBlobGrant,
  implicitXBlobTransfer,
  xblobUnlink,
  xblobUnlinkWindow,
};
