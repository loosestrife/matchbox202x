const serverGlobals = {
  channelNatTable: {},
  globalTransactionIdCounter: 1,
  getNextTxId: () => serverGlobals.globalTransactionIdCounter++,
};
module.exports = serverGlobals;