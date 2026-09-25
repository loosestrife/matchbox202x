// index.js
const x11 = require('../x11-promises/x11-promises');
const {Logger} = require('../server-tools');
const logger = new Logger({module: 'index.js'});
logger.setProjectName('xintent-router');

(async () => {
  Object.assign(module.exports, await x11.createClientWithPromises(), { x11 });
  module.exports.routerWin = module.exports.X.AllocID();
  require('./server');
})().catch(e => { logger.error(e); process.exit(1); });