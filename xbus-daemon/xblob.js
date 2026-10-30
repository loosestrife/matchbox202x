// xblob.js for xbus-daemon
const xintent = require('../x11-promises/xintent.js');
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'xblob' });
const daemon = require('./index.js');
const gc = require('./xblob-gc.js');
const ops = require('./xblob-ops.js');

const { xblobRegistry } = ops;
const connectedHosts = new Map();

const handleXBlobCreateV0 = {
  parse: (ev) => {
    const targetWin = ev.wid;
    const [senderWin, cookie, typeAtom, initialHardLinker] = ev.data;
    return { targetWin, senderWin, cookie, typeAtom: typeAtom || 0, initialHardLinker: initialHardLinker || 0 };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobCreate',
    resources: [{ typeAtom: parsed.typeAtom }],
  }),
  accept: async (parsed) => {
    const blobId = await ops.xblobCreate(parsed.senderWin, null, parsed.typeAtom, parsed.initialHardLinker);
    logger.info(`XBlobCreate created ${xintent.widString(blobId)} (typeAtom: ${xintent.widString(parsed.typeAtom || 0)}) from ${xintent.widString(parsed.senderWin)}${parsed.initialHardLinker ? ` (hardLinker: ${xintent.widString(parsed.initialHardLinker)})` : ''}`);

    const responseEv = Buffer.alloc(32);
    responseEv.writeInt8(33, 0);
    responseEv.writeInt8(32, 1);
    responseEv.writeUInt32LE((parsed.senderWin || 0) >>> 0, 4);
    responseEv.writeUInt32LE((xintent.atoms.XBLOB_CREATE_RESPONSE_V0 || 0) >>> 0, 8);
    responseEv.writeUInt32LE((daemon.routerWin || 0) >>> 0, 12);
    responseEv.writeUInt32LE((blobId || 0) >>> 0, 16);
    responseEv.writeUInt32LE((parsed.cookie || 0) >>> 0, 20);

    await daemon.X.SendEvent(parsed.senderWin, false, daemon.x11.eventMask.NoEventMask, responseEv);
  },
};

const handleXBlobGrantV0 = {
  parse: (ev) => {
    const [senderWin, blobId, grantee] = ev.data;
    return { targetWin: ev.wid, senderWin, blobId, grantee };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobGrant',
    resources: [{
      XBlob: parsed.blobId,
      exists: parsed.blobId in xblobRegistry,
      authorized: !!(xblobRegistry[parsed.blobId]?.links.filter((win) => gc.sameClient(parsed.senderWin, win)).length),
    }],
  }),
  accept: (parsed) => {
    logger.info(`XBlobGrant granting ${xintent.widString(parsed.blobId)} to ${xintent.widString(parsed.grantee)} from ${xintent.widString(parsed.senderWin)}`);
    ops.implicitXBlobGrant(parsed.blobId, parsed.grantee);
  },
};

const handleXBlobUnlinkV0 = {
  parse: (ev) => {
    const [senderWin, blobId] = ev.data;
    return { targetWin: ev.wid, senderWin, blobId };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobUnlink',
    resources: [{ XBlob: parsed.blobId }],
  }),
  accept: async (parsed) => {
    logger.info(`XBlobUnlink unlinking ${xintent.widString(parsed.blobId)} from ${xintent.widString(parsed.senderWin)}`);
    await ops.xblobUnlink(parsed.blobId, parsed.senderWin);
  },
};

const handleXBlobSoftLinkV0 = {
  parse: (ev) => {
    const [senderWin, blobId] = ev.data;
    return { targetWin: ev.wid, senderWin, blobId };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobSoftLink',
    resources: [{ XBlob: parsed.blobId }],
  }),
  accept: async ({ senderWin, blobId }) => {
    logger.info(`XBlobSoftLink soft linking ${xintent.widString(blobId)} from ${xintent.widString(senderWin)}`);
    if (xblobRegistry[blobId]) {
      xblobRegistry[blobId].softLinks.push(senderWin);
    }
  },
};

const handleXBlobSoftUnlinkV0 = {
  parse: (ev) => {
    const [senderWin, blobId] = ev.data;
    return { targetWin: ev.wid, senderWin, blobId };
  },
  securityContext: ({ senderWin, blobId }) => ({
    source: { window: senderWin },
    action: 'XBlobSoftUnlink',
    resources: [{ XBlob: blobId }],
  }),
  accept: async ({ blobId, senderWin }) => {
    logger.info(`XBlobSoftUnlink soft unlinking ${xintent.widString(blobId)} from ${xintent.widString(senderWin)}`);
    if (xblobRegistry[blobId]) {
      const link = xblobRegistry[blobId].softLinks.indexOf(senderWin);
      if (link !== -1) {
        xblobRegistry[blobId].softLinks.splice(link, 1);
      }
      await gc.checkForDeletion(blobId, xblobRegistry[blobId], xblobRegistry);
    }
  },
};

const handleXBlobAnnounceHostV0 = {
  parse: (ev) => {
    const [senderWin, blobId, hostWin, typeAtom] = ev.data;
    return { targetWin: ev.wid, senderWin, blobId, host: hostWin || senderWin, typeAtom: typeAtom || 0 };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobAnnounceHost',
    resources: [{ XBlob: parsed.blobId, typeAtom: parsed.typeAtom }],
  }),
  accept: async ({ blobId, host, typeAtom }) => {
    const regEntry = xblobRegistry[blobId];
    if (!regEntry) return;
    if (typeAtom && !regEntry.typeAtom) {
      regEntry.typeAtom = typeAtom;
    }
    if (host && !regEntry.hosts.includes(host)) {
      regEntry.hosts.push(host);
      logger.info(`XBlobAnnounceHost registered host ${xintent.widString(host)} (typeAtom: ${xintent.widString(regEntry.typeAtom || 0)}) for blob ${xintent.widString(blobId)}`);
    }
  },
};

const handleXBlobDropHostV0 = {
  parse: (ev) => {
    const [senderWin, blobId, hostWin] = ev.data;
    return { targetWin: ev.wid, senderWin, blobId, host: hostWin || senderWin };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobDropHost',
    resources: [{ XBlob: parsed.blobId }],
  }),
  accept: async ({ blobId, host }) => {
    const regEntry = xblobRegistry[blobId];
    if (!regEntry || !host) return;
    const idx = regEntry.hosts.indexOf(host);
    if (idx !== -1) {
      regEntry.hosts.splice(idx, 1);
      logger.info(`XBlobDropHost dropped host ${xintent.widString(host)} from blob ${xintent.widString(blobId)}`);
    }
  },
};

const handleXBlobHostConnectV0 = {
  parse: (ev) => {
    const [senderWin, hostWin, socketPathAtom, hostNameAtom] = ev.data;
    return { targetWin: ev.wid, senderWin, hostWin: hostWin || senderWin, socketPathAtom, hostNameAtom };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobHostConnect',
    resources: [],
  }),
  accept: async ({ senderWin, hostWin, socketPathAtom, hostNameAtom }, X) => {
    const { windowRegistry } = require('./xintent-registry');
    let socketPath = 'unknown';
    if (socketPathAtom && X) {
      try {
        const prop = await X.GetProperty(0, hostWin, socketPathAtom, 0, 0, 1000);
        if (prop && prop.data) socketPath = prop.data.toString('utf8');
      } catch (_) {}
    }
    let hostName = windowRegistry[senderWin]?.XBlobHost?.host || 'unknown';
    if (hostNameAtom && X) {
      try {
        const atomName = await X.GetAtomName(hostNameAtom);
        if (atomName) hostName = atomName;
      } catch (_) {}
    }
    connectedHosts.set(senderWin, { hostName, hostWin, socketPath, connectedAt: new Date() });
    logger.info(`XBlobHostConnect registered secondary host '${hostName}' (${xintent.widString(hostWin)}, socket: ${socketPath})`);
  },
};

const corkedBlobWindows = new Map(); // win -> Array<{ atom, data }>

function corkWindowBlobEvents(win) {
  if (!win) return;
  if (!corkedBlobWindows.has(win)) {
    corkedBlobWindows.set(win, []);
    logger.info(`Corked XBlob notifications for window ${xintent.widString(win)}`);
  }
}

async function uncorkAndFlushWindowBlobEvents(oldWin, newWin) {
  const targetWin = newWin || oldWin;
  const queued = corkedBlobWindows.get(oldWin) || [];
  corkedBlobWindows.delete(oldWin);
  if (newWin && newWin !== oldWin) {
    corkedBlobWindows.delete(newWin);
  }
  if (!targetWin || queued.length === 0) return;

  logger.info(`Flushing ${queued.length} corked XBlob notification(s) to ${xintent.widString(targetWin)}`);
  for (const item of queued) {
    try {
      if (daemon.X && typeof daemon.X.SendEvent === 'function') {
        await xintent.XClientMessage(daemon.X, targetWin, item.atom, item.data);
      }
    } catch (_) {}
  }
}

const handleXBlobBroadcastV0 = {
  parse: (ev) => {
    const [senderWin, blobId, host, version] = ev.data;
    return { targetWin: ev.wid, senderWin, blobId, host, version };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobBroadcast',
    resources: [{ XBlob: parsed.blobId }],
  }),
  accept: async ({ senderWin, blobId, host, version }) => {
    logger.info(`XBlobBroadcast broadcasting version ${version} on host ${xintent.widString(host)} of ${xintent.widString(blobId)} from ${xintent.widString(senderWin)}`);
    const regEntry = xblobRegistry[blobId];
    if (regEntry && host && !regEntry.hosts.includes(host)) {
      regEntry.hosts.push(host);
    }
    const targets = [...new Set([...(regEntry?.links || []), ...(regEntry?.softLinks || [])])];
    for (const broadcastTarget of targets) {
      if (broadcastTarget === senderWin || broadcastTarget === daemon.routerWin) continue;
      if (corkedBlobWindows.has(broadcastTarget)) {
        corkedBlobWindows.get(broadcastTarget).push({
          atom: xintent.atoms.XBLOB_BROADCAST_V0,
          data: [senderWin, blobId, host, version],
        });
        continue;
      }
      try {
        if (daemon.X && typeof daemon.X.SendEvent === 'function') {
          xintent.XClientMessage(daemon.X, broadcastTarget, xintent.atoms.XBLOB_BROADCAST_V0, [
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

const handleXBlobStreamClosedV0 = {
  parse: (ev) => {
    const [senderWin, blobId, host, sizeLow, sizeHigh] = ev.data;
    const low = (sizeLow || 0) >>> 0;
    const high = (sizeHigh || 0) >>> 0;
    return {
      targetWin: ev.wid,
      senderWin,
      blobId,
      host,
      sizeLow: low,
      sizeHigh: high,
      size: high * 0x100000000 + low,
    };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobStreamClosed',
    resources: [{ XBlob: parsed.blobId }],
  }),
  accept: async ({ senderWin, blobId, host, sizeLow, sizeHigh, size }) => {
    const resolvedLow = (sizeLow !== undefined ? sizeLow : (Number(size) || 0)) >>> 0;
    const resolvedHigh = (sizeHigh !== undefined ? sizeHigh : Math.floor((Number(size) || 0) / 0x100000000)) >>> 0;
    const resolvedSize = size !== undefined ? size : resolvedHigh * 0x100000000 + resolvedLow;
    logger.info(`XBlobStreamClosed stream closed (size: ${resolvedSize}) on host ${xintent.widString(host)} of ${xintent.widString(blobId)} from ${xintent.widString(senderWin)}`);
    const regEntry = xblobRegistry[blobId];
    if (regEntry) {
      regEntry.size = resolvedSize;
      if (host && !regEntry.hosts.includes(host)) {
        regEntry.hosts.push(host);
      }
    }
    const targets = [...new Set([...(regEntry?.links || []), ...(regEntry?.softLinks || [])])];
    for (const target of targets) {
      if (target === senderWin || target === daemon.routerWin) continue;
      if (corkedBlobWindows.has(target)) {
        corkedBlobWindows.get(target).push({
          atom: xintent.atoms.XBLOB_STREAM_CLOSED_V0,
          data: [senderWin, blobId, host, resolvedLow, resolvedHigh],
        });
        continue;
      }
      try {
        if (daemon.X && typeof daemon.X.SendEvent === 'function') {
          xintent.XClientMessage(daemon.X, target, xintent.atoms.XBLOB_STREAM_CLOSED_V0, [
            senderWin,
            blobId,
            host,
            resolvedLow,
            resolvedHigh,
          ]);
        }
      } catch (_) {}
    }
  },
};

const handleXBlobTransferV0 = {
  parse: (ev) => {
    const [senderWin, blobId, grantee] = ev.data;
    return { targetWin: ev.wid, senderWin, blobId, grantee };
  },
  securityContext: (parsed) => ({
    source: { window: parsed.senderWin },
    action: 'XBlobTransfer',
    resources: [{
      XBlob: parsed.blobId,
      exists: parsed.blobId in xblobRegistry,
      authorized: !!(xblobRegistry[parsed.blobId]?.links.filter((win) => gc.sameClient(parsed.senderWin, win)).length),
    }],
  }),
  accept: async (parsed) => {
    logger.info(`XBlobTransfer transferring ${xintent.widString(parsed.blobId)} from ${xintent.widString(parsed.senderWin)} to ${xintent.widString(parsed.grantee)}`);
    await ops.implicitXBlobTransfer(parsed.blobId, parsed.senderWin, parsed.grantee);
  },
};

module.exports = {
  xblobRegistry,
  connectedHosts,
  handleXBlobCreateV0,
  handleXBlobGrantV0,
  handleXBlobUnlinkV0,
  handleXBlobTransferV0,
  handleXBlobBroadcastV0,
  handleXBlobStreamClosedV0,
  handleXBlobSoftLinkV0,
  handleXBlobSoftUnlinkV0,
  handleXBlobAnnounceHostV0,
  handleXBlobDropHostV0,
  handleXBlobHostConnectV0,
  xblobCreate: ops.xblobCreate,
  implicitXBlobGrant: ops.implicitXBlobGrant,
  implicitXBlobTransfer: ops.implicitXBlobTransfer,
  xblobUnlink: ops.xblobUnlink,
  xblobUnlinkWindow: ops.xblobUnlinkWindow,
  migrateWindowBlobs: ops.migrateWindowBlobs,
  corkWindowBlobEvents,
  uncorkAndFlushWindowBlobEvents,
};
