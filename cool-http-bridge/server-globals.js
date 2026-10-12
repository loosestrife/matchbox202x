const dgram = require('dgram');
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'udp-wake' });

const serverGlobals = {
  channelNatTable: {},
  lastKnownDeviceIps: {},
  deviceProxyWindows: {},  // appName/xaudioSink -> { wid, widHex, appName, xaudioSink, clientIp, updatedAt }
  proxyWindowToDevice: {}, // widHex -> appName
  globalTransactionIdCounter: 1,
  getNextTxId: () => serverGlobals.globalTransactionIdCounter++,
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
