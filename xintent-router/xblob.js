// xblob.js
const {atoms, widString, parseJsonFrame} = require('../x11-promises/xintent.js');
const {X, rawX, x11, root, routerWin} = require('./index.js');

const xblobRegistry = {};
const xblobAtoms = [];
const xblobAtomAssignments = [];
const xblobHosts = {};

const handleXBlobCreateV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, cookie] = ev.data;
    return {targetWin, senderWin, cookie};
  },
  securityContext: parsed => {
    return {
      source: {window: parsed.senderWin},
      action: 'XBlobCreate',
    };
  },
  accept: async parsed => {
    const blobAtom = await xblobCreate(parsed.senderWin);
    console.log(`XBlobCreate created ${widString(blobAtom)} from ${widString(parsed.senderWin)}`);

    const responseEv = Buffer.alloc(32);
    responseEv.writeInt8(33, 0); // ClientMessage
    responseEv.writeInt8(32, 1); // 32-bit format
    responseEv.writeUInt32LE(parsed.senderWin, 4);
    responseEv.writeUInt32LE(atoms.XBLOB_CREATE_RESPONSE_V0, 8);
    responseEv.writeUInt32LE(routerWin, 12);     // data.l[0] = senderWin (router)
    responseEv.writeUInt32LE(blobAtom, 16);      // data.l[1] = allocated blob atom
    responseEv.writeUInt32LE(parsed.cookie, 20); // data.l[2] = client cookie

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
    console.log(`XBlobGrant granting ${widString(parsed.blobId)} to ${widString(parsed.grantee)} from ${widString(parsed.senderWin)}`);
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
    console.log(`XBlobUnlink unlinking ${widString(parsed.blobId)} from ${widString(parsed.senderWin)}`);
    await xblobUnlink(parsed.blobId, parsed.senderWin);
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
    console.log(`XBlobTransfer transferring ${widString(parsed.blobId)} from ${widString(parsed.senderWin)} to ${widString(parsed.grantee)}`);
    await implicitXBlobTransfer(parsed.blobId, parsed.senderWin, parsed.grantee);
  },
};

const handleXAudioNodeRegisterV0 = {
  parse: async ev => {
    const {senderWin, payload} = await parseJsonFrame(X, routerWin, ev);
    return {senderWin, hostName: payload.hostName};
  },
  securityContext: parsed => {
    return {source: {window: parsed.senderWin}, action: 'XAudioNodeRegister'};
  },
  accept: parsed => {
    xblobHosts[parsed.hostName] = parsed.senderWin;
  }
};

const xblobCreate = async (senderWin) => {
  const blobTrackingData = { links: [senderWin] };

  let blobIdx = xblobAtomAssignments.findIndex(slot => !slot);
  if (blobIdx === -1) {
    blobIdx = xblobAtomAssignments.length;
  }
  let blobAtom = xblobAtoms[blobIdx];
  if (!blobAtom) {
    blobAtom = await X.InternAtom(false, `XBLOB_BLOB_SLOT_${blobIdx}`);
    xblobAtoms[blobIdx] = blobAtom;
    // initially claim ownership for this XAudioNode
    X.SetSelectionOwner(routerWin, blobAtom, 0);
  }
  xblobAtomAssignments[blobIdx] = blobTrackingData;
  xblobRegistry[blobAtom] = blobTrackingData;

  return blobAtom;
};

const implicitXBlobGrant = (blobId, grantee) => {
  if (xblobRegistry[blobId]) {
    xblobRegistry[blobId].links.push(grantee);
  }
};

const xblobUnlink = async (blobId, unlinkWin) => {
  const regEntry = xblobRegistry[blobId];
  if (!regEntry) {
    console.log(`xblobUnlink: no such blob ${widString(blobId)}`);
    return;
  }
  const link = regEntry.links.indexOf(unlinkWin);
  if (link === -1) {
    console.log(`Attempt to unlink blob ${widString(blobId)} from window ${widString(unlinkWin)} which isn't linked`, xblobRegistry);
  } else {
    regEntry.links.splice(link, 1);
  }

  if (regEntry.links.length === 0) {
    console.log(`deleting unlinked blob ${widString(blobId)}`);
    await X.DeleteProperty(routerWin, blobId);
    delete xblobRegistry[blobId];

    const blobIdx = xblobAtoms.indexOf(blobId);
    if (blobIdx !== -1) {
      xblobAtomAssignments[blobIdx] = undefined;
    }
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
  // 1. Unlink the destroyed window from all blobs it is linked to
  const blobIds = Object.keys(xblobRegistry);
  for (const blobIdStr of blobIds) {
    const blobId = Number(blobIdStr);
    const regEntry = xblobRegistry[blobId];

    if (regEntry?.links) {
      // Remove all instances of destroyedWin linked to this blob
      while (regEntry.links.includes(destroyedWin)) {
        await xblobUnlink(blobId, destroyedWin);
      }
    }
  }

  // 2. Remove any host registrations owned by the destroyed window
  for (const [hostName, hostWin] of Object.entries(xblobHosts)) {
    if (hostWin === destroyedWin) {
      delete xblobHosts[hostName];
    }
  }
};

module.exports = {
  handleXBlobCreateV0,
  handleXBlobGrantV0,
  handleXBlobUnlinkV0,
  handleXBlobTransferV0,
  handleXAudioNodeRegisterV0,
  xblobCreate,
  implicitXBlobGrant,
  implicitXBlobTransfer,
  xblobUnlink,
  xblobUnlinkWindow,
};