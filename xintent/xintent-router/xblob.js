// xblob.js
const {atoms, widString, parseJsonFrame} = require('../util/xintent');
const {X, rawX, root, routerWin} = require('./index.js');

const xblobRegistry = {};
const xblobHosts = {};

const handleXBlobCreateV0 = {
  parse: ev => {
    const targetWin = ev.wid;
    const [senderWin, blobId] = ev.data;
    return {targetWin, senderWin, blobId};
  },
  securityContext: parsed => {
    return {
      source: {window: parsed.senderWin},
      action: 'XBlobCreate',
      resources: [{XBlob: parsed.blobId}],
    }
  },
  accept: parsed => {
    console.log(`XBlobCreate creating ${widString(parsed.blobId)} from ${widString(parsed.senderWin)}`);
    xblobCreate(parsed.blobId, parsed.senderWin);
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
    }
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
    }
  },
  accept: async parsed => {
    console.log(`XBlobUnlink unlinking ${widString(parsed.blobId)} from ${widString(parsed.senderWin)}`);
    await xblobUnlink(parsed.blobId, parsed.senderWin);
  },
};
const handleXAudioNodeRegisterV0 = {
  parse: async ev => {
    const {senderWin, payload} = await parseJsonFrame(X, routerWin, ev);
    return {senderWin, hostName: payload.hostName};
  },
  securityContext: parsed => {
    return {source: {window: parsed.senderWin}, action: 'XAudioNodeRegister'}
  },
  accept: parsed => {
    xblobHosts[parsed.hostName] = parsed.senderWin;
  }
};


const xblobCreate = (blobId, senderWin) => {
  xblobRegistry[blobId] = {links: [senderWin]};
};
const implicitXBlobGrant = (blobId, grantee) => {
  xblobRegistry[blobId].links.push(grantee);
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
  }
};
const implicitXBlobTransfer = async (blobId, fromWin, toWin) => {
  implicitXBlobGrant(blobId, toWin);
  await xblobUnlink(blobId, fromWin);
};



// Modern Xorg hands out 21-bit masks (IDs like 0x3a00003 with base 0x3a00000).
// Fallback only if the wrapper doesn't expose the setup reply.
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


module.exports = {
  handleXBlobCreateV0,
  handleXBlobGrantV0,
  handleXBlobUnlinkV0,
  handleXAudioNodeRegisterV0,
  xblobCreate,
  implicitXBlobGrant,
  implicitXBlobTransfer,
  xblobUnlink,
};