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
  registerCardWindow: (wid, appId = 'xhtml-card', cardId = 'main', ws = null) => {
    const numWid = serverGlobals.parseWindowId(wid);
    if (!numWid) return null;
    const widHex = `0x${numWid.toString(16)}`;
    const existing = serverGlobals.cardWindows[widHex] || {};
    const wsSet = existing.wsSet || new Set();
    if (ws) wsSet.add(ws);
    const record = {
      ...existing,
      wid: numWid,
      widHex,
      appId: appId || existing.appId || 'xhtml-card',
      cardId: cardId || existing.cardId || 'main',
      ws: ws || existing.ws || null,
      wsSet,
      bufferedFrames: existing.bufferedFrames || [],
      bufferedBlobEvents: existing.bufferedBlobEvents || [],
      createdAt: existing.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
    serverGlobals.cardWindows[widHex] = record;
    return record;
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
