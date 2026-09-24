// index.js
const x11 = require('../x11-promises/x11-promises');

(async () => {
  Object.assign(module.exports, await x11.createClientWithPromises(), { x11 });
  module.exports.routerWin = module.exports.X.AllocID();
  require('./server');
})().catch(e => { console.error(e); process.exit(1); });