// daemon-launcher.js for cool-service-lighter
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const xintent = require('../x11-promises/xintent');
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'daemon-launcher' });
const { spawnRuntime, trackChild } = require('./process-supervisor');

function checkHttpBridge(port = 12345) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/tags`, { timeout: 200 }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureXBusDaemon(X, root) {
  let routerWin = await xintent.connectToRouter(X, root, 0);
  if (!routerWin) {
    logger.info('[cool-service-lighter] xbus-daemon not detected on XCHANNEL atom. Auto-launching xbus-daemon...');
    const busDir = path.join(__dirname, '../xbus-daemon');
    const busEntryFile = path.join(busDir, 'index.js');

    if (fs.existsSync(busEntryFile)) {
      spawnRuntime(busEntryFile, busDir);
    } else {
      const routerDir = path.join(__dirname, '../cool-intent-router');
      const entryFile = path.join(routerDir, 'index.js');
      spawnRuntime(entryFile, routerDir);
    }

    routerWin = await new Promise((resolve) => {
      const eventHandler = async (ev) => {
        if (ev.name === 'PropertyNotify' && ev.wid === root) {
          const win = await xintent.connectToRouter(X, root, 0);
          if (win) {
            X.removeListener('event', eventHandler);
            resolve(win);
          }
        }
      };

      X.on('event', eventHandler);

      setTimeout(async () => {
        X.removeListener('event', eventHandler);
        resolve(await xintent.connectToRouter(X, root, 0));
      }, 3000);
    });

    if (routerWin) {
      logger.info(`[cool-service-lighter] Connected to auto-launched xbus-daemon (0x${routerWin.toString(16)})`);
    } else {
      logger.warn('[cool-service-lighter] xbus-daemon startup timed out.');
    }
  } else {
    logger.info(`[cool-service-lighter] Connected to existing xbus-daemon (0x${routerWin.toString(16)})`);
  }

  const routerDir = path.join(__dirname, '../cool-intent-router');
  const routerEntryFile = path.join(routerDir, 'index.js');
  if (fs.existsSync(routerEntryFile)) {
    logger.info('[cool-service-lighter] Auto-launching cool-intent-router Policy Engine...');
    spawnRuntime(routerEntryFile, routerDir);
  }

  return routerWin;
}

async function ensureXIntentRouter(X, root) {
  return ensureXBusDaemon(X, root);
}

async function ensureHttpBridge() {
  const httpPort = parseInt(process.env.PORT || process.env.XINTENT_PORT || '12345', 10);
  const isRunning = await checkHttpBridge(httpPort);
  if (!isRunning) {
    logger.info(`[cool-service-lighter] cool-http-bridge not detected on port ${httpPort}. Auto-launching cool-http-bridge...`);
    const bridgeDir = path.join(__dirname, '../cool-http-bridge');
    const entryFile = path.join(bridgeDir, 'index.js');

    spawnRuntime(entryFile, bridgeDir);
    logger.info(`[cool-service-lighter] Auto-launched cool-http-bridge service on port ${httpPort}.`);
  } else {
    logger.info(`[cool-service-lighter] cool-http-bridge is active on http://localhost:${httpPort}.`);
  }
}

async function ensureXdgPortalBridge() {
  const portalBridgeDir = path.join(__dirname, '../xdg-portal-bridge');
  const entryFile = path.join(portalBridgeDir, 'xintent-portal-daemon.py');

  if (fs.existsSync(entryFile)) {
    logger.info('[cool-service-lighter] Auto-launching xdg-portal-bridge...');
    try {
      const pyprojectFile = path.join(portalBridgeDir, 'pyproject.toml');
      const hasUv = fs.existsSync(pyprojectFile);
      const cmd = hasUv ? 'uv' : 'python3';
      const args = hasUv ? ['run', 'xintent-portal-daemon.py'] : ['xintent-portal-daemon.py'];

      const proc = spawn(cmd, args, {
        cwd: portalBridgeDir,
        stdio: 'inherit',
        detached: true,
      });
      trackChild(proc);
      logger.info(`[cool-service-lighter] Auto-launched xdg-portal-bridge service using ${cmd}.`);
    } catch (err) {
      logger.error('[cool-service-lighter] Failed to launch xdg-portal-bridge:', err);
    }
  }
}

module.exports = {
  checkHttpBridge,
  ensureXBusDaemon,
  ensureXIntentRouter,
  ensureHttpBridge,
  ensureXdgPortalBridge,
};
