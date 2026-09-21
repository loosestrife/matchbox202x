// xblob.js
const {atoms, widString, parseJsonFrame} = require('../util/xintent');
const {X, rawX, root, routerWin} = require('./index.js');

const xblobRegistry = {};
const xblobHosts = {};

const handleXBlobCreateV0 = {};
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
    xblobRegistry[parsed.blobId].links.push(parsed.grantee);
  },
};
const implicitXBlobGrant = (blobId, grantee) => {
  xblobRegistry[blobId].links.push(grantee);
}
const handleXBlobUnlinkV0 = {};
const handleXAudioNodeRegisterV0 = {
  parse: async ev => {
    const {senderWin, payload} = await parseJsonFrame(X, ev);
    return {senderWin, hostName: payload.hostName};
  },
  securityContext: parsed => {
    return {source: {window: parsed.senderWin}, action: 'XAudioNodeRegister'}
  },
  accept: parsed => {
    xblobHosts[parsed.hostName] = parsed.senderWin;
  }
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
  implicitXBlobGrant,
};