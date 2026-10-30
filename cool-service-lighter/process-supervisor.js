// process-supervisor.js for cool-service-lighter
const { spawn } = require('child_process');
const { Logger } = require('../server-tools');
const logger = new Logger({ module: 'process-supervisor' });

const children = new Set();

function trackChild(proc) {
  if (!proc || !proc.pid) return proc;
  children.add(proc);
  const cleanup = () => children.delete(proc);
  proc.on('exit', cleanup);
  proc.on('error', cleanup);
  return proc;
}

function killChild(proc, signal = 'SIGINT') {
  if (!proc || !proc.pid) return;
  try {
    if (proc.detached) {
      try {
        process.kill(-proc.pid, signal);
      } catch (_) {
        proc.kill(signal);
      }
    } else {
      proc.kill(signal);
    }
  } catch (_) {}
}

function forwardSignalAndExit(signal) {
  logger.info(`Received ${signal}. Forwarding to ${children.size} child process(es)...`);
  for (const proc of children) {
    killChild(proc, signal);
  }
  children.clear();
  process.exit(0);
}

function setupSignalHandlers() {
  process.on('SIGINT', () => forwardSignalAndExit('SIGINT'));
  process.on('SIGTERM', () => forwardSignalAndExit('SIGTERM'));
}

function spawnRuntime(cmdFile, workingDir) {
  try {
    const proc = spawn('bun', [cmdFile], {
      cwd: workingDir,
      stdio: 'inherit',
      detached: true,
    });
    proc.detached = true;
    trackChild(proc);
    proc.on('error', () => {
      const fallbackProc = spawn('node', [cmdFile], {
        cwd: workingDir,
        stdio: 'inherit',
        detached: true,
      });
      fallbackProc.detached = true;
      trackChild(fallbackProc);
    });
    return proc;
  } catch (_) {
    const fallbackProc = spawn('node', [cmdFile], {
      cwd: workingDir,
      stdio: 'inherit',
      detached: true,
    });
    fallbackProc.detached = true;
    trackChild(fallbackProc);
    return fallbackProc;
  }
}

module.exports = {
  children,
  trackChild,
  killChild,
  forwardSignalAndExit,
  setupSignalHandlers,
  spawnRuntime,
};
