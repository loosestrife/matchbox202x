#!/usr/bin/env bun
// cool-terminal/index.js - XIntent TTY / Terminal Stream Service
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { dlopen, FFIType, CString, ptr } = require('bun:ffi');
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');
const { Logger } = require('../server-tools');

const logger = new Logger({ module: 'cool-terminal' });
logger.setProjectName('cool-terminal');

const O_RDWR = 2;
const O_NOCTTY = 0x100;

const libc = dlopen('libc.so.6', {
  posix_openpt: { args: [FFIType.i32], returns: FFIType.i32 },
  grantpt: { args: [FFIType.i32], returns: FFIType.i32 },
  unlockpt: { args: [FFIType.i32], returns: FFIType.i32 },
  ptsname: { args: [FFIType.i32], returns: FFIType.ptr },
  pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
});

const MATCHBOX_TOML_MANIFEST = `
[app]
id = "cool-terminal"
name = "Cool Terminal"
description = "XIntent TTY / Terminal Stream Service"

[intents."term.GetOutStream"]
invocation = "X11"
`;

const activeSessions = new Set();

function createOsPipe() {
  const fds = new Int32Array(2);
  const rc = libc.symbols.pipe(ptr(fds));
  if (rc !== 0) {
    throw new Error(`pipe(2) failed with return code ${rc}`);
  }
  return { readFd: fds[0], writeFd: fds[1] };
}

function allocatePtySession(payload = {}) {
  const explicitTty = payload.tty || payload.device;
  if (explicitTty && explicitTty !== 'ptmx' && explicitTty !== 'pty' && fs.existsSync(explicitTty)) {
    const ttyFd = fs.openSync(explicitTty, O_RDWR | O_NOCTTY);
    return { ttyFd, ttyPath: explicitTty, childProc: null };
  }

  const masterFd = libc.symbols.posix_openpt(O_RDWR | O_NOCTTY);
  if (masterFd < 0) {
    throw new Error('posix_openpt(/dev/ptmx) failed');
  }
  if (libc.symbols.grantpt(masterFd) !== 0 || libc.symbols.unlockpt(masterFd) !== 0) {
    try { fs.closeSync(masterFd); } catch (_) {}
    throw new Error('grantpt/unlockpt failed on pty master');
  }

  const slavePtr = libc.symbols.ptsname(masterFd);
  const slavePath = slavePtr ? new CString(slavePtr).toString() : null;
  if (!slavePath) {
    try { fs.closeSync(masterFd); } catch (_) {}
    throw new Error('ptsname failed on pty master');
  }

  let childProc = null;
  if (payload.spawnShell !== false) {
    const slaveFd = fs.openSync(slavePath, 'r+');
    const cmd = payload.command || payload.shell || process.env.SHELL || '/bin/sh';
    const args = Array.isArray(payload.args) ? payload.args : [];
    childProc = spawn(cmd, args, {
      stdio: [slaveFd, slaveFd, slaveFd],
      env: { ...process.env, TERM: payload.term || process.env.TERM || 'xterm-256color' },
      detached: true,
    });
    try { fs.closeSync(slaveFd); } catch (_) {}
  }

  return { ttyFd: masterFd, ttyPath: slavePath, childProc };
}

function parseBlobId(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val >>> 0;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    const num = (trimmed.startsWith('0x') || trimmed.startsWith('0X'))
      ? parseInt(trimmed, 16)
      : Number(trimmed);
    return isNaN(num) ? 0 : (num >>> 0);
  }
  return 0;
}

async function attachInputStreamToTty(X, termWin, inBlobId, ttyFd) {
  if (!inBlobId) return null;
  const inBlob = await xintent.XBlobRead(
    X,
    xintent.routerWin,
    inBlobId,
    null,
    null,
    termWin,
    'cool-terminal',
    { receiveFd: true, acceptReadableStream: true }
  );

  if (!inBlob || typeof inBlob.data !== 'number' || inBlob.data < 0) {
    throw new Error(`Failed to resolve input ReadableStream FD from XBlob ${xintent.widString(inBlobId)}`);
  }

  const inFd = inBlob.data;
  const inStream = fs.createReadStream(null, { fd: inFd, autoClose: true });
  inStream.on('data', (chunk) => {
    try {
      fs.writeSync(ttyFd, chunk);
    } catch (err) {
      logger.debug(`TTY write error on fd ${ttyFd}: ${err.message}`);
    }
  });
  inStream.on('error', (err) => {
    logger.debug(`Input ReadableStream error for XBlob ${xintent.widString(inBlobId)}: ${err.message}`);
  });
  return inStream;
}

async function createOutputStreamFromTty(X, termWin, ttyFd, ttyPath, session) {
  const { readFd: outReadFd, writeFd: outWriteFd } = createOsPipe();
  const outBlobId = await xintent.XBlobCreate(X, xintent.routerWin, termWin, {
    xblobType: 'ReadableStream',
    type: 'application/octet-stream',
    name: path.basename(ttyPath || 'tty'),
    data: `/proc/${process.pid}/fd/${outReadFd}`,
    _dataType: 'fd-rights',
    contentEncoding: 'fd-rights',
  });
  try { fs.closeSync(outReadFd); } catch (_) {}

  let bytesWritten = 0;
  let closed = false;
  const closeOutStream = () => {
    if (closed) return;
    closed = true;
    try { fs.closeSync(outWriteFd); } catch (_) {}
    try { fs.closeSync(ttyFd); } catch (_) {}
    activeSessions.delete(session);
    xintent.XBlobStreamClosed(X, xintent.routerWin, termWin, outBlobId, termWin, bytesWritten).catch(() => {});
  };

  const ttyReadStream = fs.createReadStream(null, { fd: ttyFd, autoClose: false });
  ttyReadStream.on('data', (chunk) => {
    try {
      fs.writeSync(outWriteFd, chunk);
      bytesWritten += chunk.length;
    } catch (_) {
      closeOutStream();
    }
  });
  ttyReadStream.on('end', closeOutStream);
  ttyReadStream.on('error', closeOutStream);

  if (session.childProc) {
    session.childProc.on('exit', () => {
      setTimeout(closeOutStream, 50);
    });
  }

  session.closeOutStream = closeOutStream;
  return outBlobId;
}

async function handleGetOutStreamIntent(X, termWin, frame) {
  const { payload = {}, channel, dataBlob } = frame;
  const inBlobId = parseBlobId(dataBlob || payload.dataBlob || payload.inBlob || payload.blob);

  logger.info(
    `Received term.GetOutStream (channel=${channel}, inBlob=${inBlobId ? xintent.widString(inBlobId) : 'none'}, tty=${payload.tty || 'pty'})`
  );

  const session = allocatePtySession(payload);
  activeSessions.add(session);

  if (inBlobId) {
    session.inStream = await attachInputStreamToTty(X, termWin, inBlobId, session.ttyFd);
  }

  const outBlobId = await createOutputStreamFromTty(X, termWin, session.ttyFd, session.ttyPath, session);

  const requestedIntent = payload.intent || payload.action || 'term.GetOutStream';
  const responseEventName = requestedIntent === 'term.getOutStream'
    ? 'term.getOutStreamResponse'
    : 'term.GetOutStreamResponse';

  await xintent.sendXIntentEventV0(X, xintent.routerWin, {
    senderWin: termWin,
    channel,
    controlWord: 2, // FIN
    dataBlob: outBlobId,
    payload: {
      event: responseEventName,
      disposition: 'final',
      status: 'ok',
      tty: session.ttyPath,
    },
  });

  logger.info(
    `Dispatched ${responseEventName} on channel ${channel} with outStream ReadableStream XBlob ${xintent.widString(outBlobId)} (tty=${session.ttyPath})`
  );
}

async function startTerminalService() {
  xintent.init({ logger: new Logger({ module: 'libxintent' }) });
  const { X, root } = await x11.createClientWithPromises();
  await xintent.connectToRouter(X, root);

  if (!xintent.routerWin) {
    logger.error('Could not connect to XINTENT router');
    process.exit(1);
  }

  const termWin = await xintent.createClientWindow(X, root, 'cool-terminal');

  X.ChangeProperty(
    0,
    termWin,
    xintent.atoms.MATCHBOX_TOML,
    xintent.atoms.STRING,
    8,
    Buffer.from(MATCHBOX_TOML_MANIFEST, 'utf8')
  );

  logger.info(`cool-terminal online on window ${xintent.widString(termWin)} (router: ${xintent.widString(xintent.routerWin)})`);

  X.on('event', async (ev) => {
    if (ev.type === 33 && ev.message_type === xintent.atoms.XINTENT_INTENT_V0) {
      try {
        const frame = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev);
        const intentName = frame.payload?.intent || frame.payload?.action;
        if (intentName === 'term.GetOutStream' || intentName === 'term.getOutStream') {
          await handleGetOutStreamIntent(X, termWin, frame);
        }
      } catch (err) {
        logger.error('Error handling term.GetOutStream in cool-terminal:', err);
      }
    }
  });
}

startTerminalService().catch((err) => {
  logger.error('Fatal startup error in cool-terminal:', err);
  process.exit(1);
});
