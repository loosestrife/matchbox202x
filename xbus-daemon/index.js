// xbus-daemon: Low-level X11, XChannel, XBlob & XAudio Busmaster Daemon
const x11 = require('../x11-promises/x11-promises');
const {Logger} = require('../server-tools');
const logger = new Logger({module: 'xbus-daemon'});
logger.setProjectName('xbus-daemon');

(async () => {
  Object.assign(module.exports, await x11.createClientWithPromises(), { x11 });
  module.exports.routerWin = module.exports.X.AllocID();
  require('./server');
})().catch(e => { logger.error(e); process.exit(1); });
