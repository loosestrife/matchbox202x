// xblob.js
const {atoms, widString, parseJsonFrame} = require('../util/xintent');
const {X, root, routerWin} = require('./index.js');

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
        authorized: xblobRegistry[parsed.blobId]?.links.filter(win => sameClient(senderWin, win)).length,
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

module.exports = {
  handleXBlobCreateV0,
  handleXBlobGrantV0,
  handleXBlobUnlinkV0,
  handleXAudioNodeRegisterV0,
  implicitXBlobGrant,
};