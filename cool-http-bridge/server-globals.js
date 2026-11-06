const dgram = require('dgram');
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'udp-wake' });

const serverGlobals = {
  channelNatTable: {},
  cardChannelTable: {}, // wid (number) -> { [txId]: session }
  cardWindows: {},      // widHex -> { wid, widHex, appId, cardId, ws, createdAt }
  lastKnownDeviceIps: {},
  deviceProxyWindows: {},  // appName/xaudioSink -> { wid, widHex, appName, xaudioSink, clientIp, updatedAt }
  proxyWindowToDevice: {}, // widHex -> appName
  globalTransactionIdCounter: 1,
  getNextTxId: () => serverGlobals.globalTransactionIdCounter++,
  advanceTxIdPast: (minTxId) => {
    const num = Number(minTxId);
    if (!isNaN(num) && num >= serverGlobals.globalTransactionIdCounter) {
      serverGlobals.globalTransactionIdCounter = num + 1;
    }
  },
  parseWindowId: (raw) => {
    if (!raw) return 0;
    if (typeof raw === 'number') return raw >>> 0;
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      const num = (trimmed.startsWith('0x') || trimmed.startsWith('0X')) ? parseInt(trimmed, 16) : Number(trimmed);
      return isNaN(num) ? 0 : (num >>> 0);
    }
    return 0;
  },
  normalizeBlobHex: (raw) => {
    const num = serverGlobals.parseWindowId(raw);
    return num ? `0x${num.toString(16)}` : null;
  },
  registerCardWindow: (wid, appId = null, cardId = null, ws = null) => {
    const numWid = serverGlobals.parseWindowId(wid);
    if (!numWid) return null;
    const widHex = `0x${numWid.toString(16)}`;
    let record = serverGlobals.cardWindows[widHex];
    if (!record) {
      record = {
        wid: numWid,
        widHex,
        appId: appId || 'xhtml-card',
        cardId: cardId || 'main',
        ws: ws || null,
        wsSet: new Set(),
        blobNatTable: {},
        reverseBlobNatTable: {},
        channelNatTable: {},
        activeReadStreams: new Set(),
        bufferedFrames: [],
        bufferedBlobEvents: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      serverGlobals.cardWindows[widHex] = record;
    } else {
      if (appId && appId !== 'xhtml-card') record.appId = appId;
      if (cardId && cardId !== 'main') record.cardId = cardId;
      if (ws) record.ws = ws;
      record.updatedAt = Date.now();
    }
    if (ws) record.wsSet.add(ws);
    return record;
  },
  setCardBlobNat: (cardWin, virtualBlobId, localBlobId) => {
    const record = serverGlobals.registerCardWindow(cardWin);
    const vHex = serverGlobals.normalizeBlobHex(virtualBlobId);
    const lHex = serverGlobals.normalizeBlobHex(localBlobId);
    if (!record || !vHex || !lHex) return null;
    const existingLocal = record.blobNatTable[vHex];
    if (existingLocal && existingLocal !== vHex && lHex === vHex) {
      return { virtualBlobId: vHex, localBlobId: existingLocal };
    }
    record.blobNatTable[vHex] = lHex;
    record.reverseBlobNatTable[lHex] = vHex;
    return { virtualBlobId: vHex, localBlobId: lHex };
  },
  translateCardBlobToLocal: (cardWin, blobId) => {
    const numWid = serverGlobals.parseWindowId(cardWin);
    const vHex = serverGlobals.normalizeBlobHex(blobId);
    if (!numWid || !vHex) return blobId;
    const widHex = `0x${numWid.toString(16)}`;
    const record = serverGlobals.cardWindows[widHex];
    const mappedHex = record?.blobNatTable?.[vHex];
    return mappedHex ? serverGlobals.parseWindowId(mappedHex) : blobId;
  },
  translateCardBlobToVirtual: (cardWin, localBlobId) => {
    const numWid = serverGlobals.parseWindowId(cardWin);
    const lHex = serverGlobals.normalizeBlobHex(localBlobId);
    if (!numWid || !lHex) return lHex || localBlobId;
    const widHex = `0x${numWid.toString(16)}`;
    const record = serverGlobals.cardWindows[widHex];
    return record?.reverseBlobNatTable?.[lHex] || lHex;
  },
  setCardChannelNat: (cardWin, virtualTxId, localTxId) => {
    const record = serverGlobals.registerCardWindow(cardWin);
    if (!record || virtualTxId === undefined || localTxId === undefined) return null;
    record.channelNatTable[String(virtualTxId)] = Number(localTxId);
    return record.channelNatTable[String(virtualTxId)];
  },
  getCardNatInfo: (cardWin) => {
    const numWid = serverGlobals.parseWindowId(cardWin);
    if (!numWid) return { blobNatTable: {}, channelNatTable: {} };
    const widHex = `0x${numWid.toString(16)}`;
    const record = serverGlobals.cardWindows[widHex];
    return {
      blobNatTable: { ...(record?.blobNatTable || {}) },
      channelNatTable: { ...(record?.channelNatTable || {}) },
    };
  },
  registerCardStream: (cardWin, readStream, res) => {
    const numWid = serverGlobals.parseWindowId(cardWin);
    if (!numWid || !readStream) return;
    const record = serverGlobals.registerCardWindow(numWid);
    if (!record) return;
    const entry = { readStream, res };
    record.activeReadStreams.add(entry);
    const cleanup = () => record.activeReadStreams.delete(entry);
    readStream.on('close', cleanup);
    readStream.on('error', cleanup);
    if (res) res.on('close', cleanup);
  },
  closeCardStreams: (cardWin) => {
    const numWid = serverGlobals.parseWindowId(cardWin);
    if (!numWid) return 0;
    const widHex = `0x${numWid.toString(16)}`;
    const record = serverGlobals.cardWindows[widHex];
    if (!record || !record.activeReadStreams) return 0;
    let closedCount = 0;
    for (const entry of Array.from(record.activeReadStreams)) {
      record.activeReadStreams.delete(entry);
      closedCount++;
      try {
        if (entry.readStream && typeof entry.readStream.unpipe === 'function') {
          entry.readStream.unpipe();
        }
        if (entry.readStream && typeof entry.readStream.destroy === 'function') {
          entry.readStream.destroy();
        }
      } catch (_) {}
      try {
        if (entry.res && !entry.res.writableEnded) {
          entry.res.end();
        }
      } catch (_) {}
    }
    return closedCount;
  },
  setChannelSession: (cardWin, txId, session) => {
    const numTxId = Number(txId);
    const numWin = serverGlobals.parseWindowId(cardWin);
    if (numWin) {
      session.cardWin = numWin;
      if (!serverGlobals.cardChannelTable[numWin]) {
        serverGlobals.cardChannelTable[numWin] = {};
      }
      serverGlobals.cardChannelTable[numWin][numTxId] = session;
    }
    serverGlobals.channelNatTable[numTxId] = session;
  },
  getChannelSession: (cardWin, txId) => {
    const numTxId = Number(txId);
    const numWin = serverGlobals.parseWindowId(cardWin);
    if (numWin && serverGlobals.cardChannelTable[numWin]?.[numTxId]) {
      return serverGlobals.cardChannelTable[numWin][numTxId];
    }
    return serverGlobals.channelNatTable[numTxId] || null;
  },
  deleteChannelSession: (cardWin, txId) => {
    const numTxId = Number(txId);
    const numWin = serverGlobals.parseWindowId(cardWin);
    if (numWin && serverGlobals.cardChannelTable[numWin]) {
      delete serverGlobals.cardChannelTable[numWin][numTxId];
      if (Object.keys(serverGlobals.cardChannelTable[numWin]).length === 0) {
        delete serverGlobals.cardChannelTable[numWin];
      }
    }
    const natEntry = serverGlobals.channelNatTable[numTxId];
    if (natEntry && (!numWin || !natEntry.cardWin || natEntry.cardWin === numWin)) {
      delete serverGlobals.channelNatTable[numTxId];
    }
  },
  sendUdpWakePing: (targetHost, port = 12346) => {
    if (!targetHost) return;
    try {
      const socket = dgram.createSocket('udp4');
      socket.send('ping', port, targetHost, (err) => {
        if (err) {
          logger.error(`UDP wake ping failed for ${targetHost}:${port}:`, err.message);
        } else {
          logger.info(`[UDP 🔔] Sent UDP wake ping to ${targetHost}:${port}`);
        }
        try { socket.close(); } catch (_) {}
      });
    } catch (err) {
      logger.error(`Error sending UDP wake ping to ${targetHost}:${port}:`, err.message);
    }
  }
};

module.exports = serverGlobals;
