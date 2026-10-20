const { isUtf8 } = require('node:buffer');
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xintent = require("../x11-promises/xintent");
const { logger, softLinks, hostBlobs, xblobDestructor } = require("./xblob-globals");
const { createXBlobSocketServer } = require("./xblob-server");

let socketServer = null;
let currentSocketPath = null;
let trackChild = proc => proc;

function execShell(command) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'inherit']
    });
    trackChild(proc);

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Command "${command}" failed with exit code ${code}`));
      }
    });
  });
}

let X;
let lighterWin;
let blobHostWin;

const pickFilePath = async xiIntent => {
  try {
    const payload = xiIntent.payload;
    const pathname = await execShell("zenity --file-selection");
    if (!pathname) throw new Error("File selection cancelled");
    const dataBlob = await xintent.XBlobCreate(X, xintent.routerWin, lighterWin, {
      xblobType: "Blob",
      type: "text/pathname",
      _dataType: "text",
      data: pathname,
    });
    xintent.XBlobTransfer(X, xintent.routerWin, lighterWin, dataBlob, xintent.routerWin);
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      targetWin: xintent.routerWin,
      senderWin: lighterWin,
      channel: xiIntent.channel,
      controlWord: 2, // FIN = 2
      payload: {
        event: "fs.PickFileResponse",
        disposition: "final",
      },
      dataBlob,
    });
  } catch (err) {
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      targetWin: xintent.routerWin,
      senderWin: lighterWin,
      channel: xiIntent.channel,
      controlWord: 2, // FIN = 2
      payload: {
        event: "http.500InternalServerError",
        disposition: "error",
        message: err.message || "File selection cancelled",
      },
    });
  }
};

const pickFile = async (xiIntent) => {
  try {
    const payload = xiIntent.payload;
    const pathname = await execShell("zenity --file-selection");
    if (!pathname) throw new Error("File selection cancelled");
    const data = fs.readFileSync(pathname);
    const isText = isUtf8(data);
    const dataBlob = await xintent.XBlobCreate(X, xintent.routerWin, lighterWin, {
      xblobType: "File",
      name: path.basename(pathname),
      type: isText ? "text/plain" : "application/octet-stream",
      _dataType: isText ? "text" : "base64",
      data: isText ? data.toString("utf-8") : data.toString("base64"),
    });
    if (payload.holdOpenForWrites) {
      xintent.XBlobSoftLink(X, xintent.routerWin, lighterWin, dataBlob);
      softLinks[dataBlob] = pathname;
    }
    xintent.XBlobTransfer(X, xintent.routerWin, lighterWin, dataBlob, xintent.routerWin);
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      targetWin: xintent.routerWin,
      senderWin: lighterWin,
      channel: xiIntent.channel,
      controlWord: 2, // FIN = 2
      payload: {
        event: "fs.PickFileResponse",
        disposition: "final",
      },
      dataBlob,
    });
  } catch (err) {
    await xintent.sendXIntentEventV0(X, xintent.routerWin, {
      targetWin: xintent.routerWin,
      senderWin: lighterWin,
      channel: xiIntent.channel,
      controlWord: 2, // FIN = 2
      payload: {
        event: "http.500InternalServerError",
        disposition: "error",
        message: err.message || "File selection cancelled",
      },
    });
  }
};

const xblobBroadcast = async message => {
  const data = await xintent.XBlobRead(X, xintent.routerWin, message.blob, message.host, message.version);
  let buf;
  if(data._dataType == 'text'){
    buf = Buffer.from(data.data, 'utf-8')
  }
  if(data._dataType == 'base64'){
    buf = Buffer.from(data.data, 'base64')
  }
  fs.writeFileSync(softLinks[message.blob], buf);
};

const handleXBlobDestructor = async message => {
  return xblobDestructor(message, X, lighterWin);
};

const init = async g => {
  X = g.X;
  lighterWin = g.lighterWin;
  blobHostWin = g.blobHostWin || lighterWin;
  if (g.trackChild) {
    trackChild = g.trackChild;
  }
  const hostname = os.hostname();
  const hostAtom = await X.InternAtom(false, `XBLOB_HOST_${hostname}`);
  X.SetSelectionOwner(blobHostWin, hostAtom, 0);

  const xblobLocalHostAtom = await X.InternAtom(false, 'XBLOB_X_SERVER_LOCAL_BLOB_HOST');
  const currentLocalOwner = await X.GetSelectionOwner(xblobLocalHostAtom);
  if (!currentLocalOwner) {
    X.SetSelectionOwner(blobHostWin, xblobLocalHostAtom, 0);
    logger.info(`Claimed selection ownership for XBLOB_X_SERVER_LOCAL_BLOB_HOST on window 0x${blobHostWin.toString(16)}`);
  }

  currentSocketPath = process.env.XBLOB_SOCKET_PATH || path.join(os.tmpdir(), `xblob-${hostname}-${process.pid}.sock`);
  const { server } = createXBlobSocketServer(currentSocketPath, xintent, X, lighterWin);
  socketServer = server;

  const xblobSocketPathAtom = await X.InternAtom(false, 'XBLOB_SOCKET_PATH');
  X.ChangeProperty(0, blobHostWin, xblobSocketPathAtom, X.atoms.STRING, 8, currentSocketPath);
  logger.info(`Advertised XBLOB_SOCKET_PATH property on blobHostWin (0x${blobHostWin.toString(16)}): ${currentSocketPath}`);
};

const sendHostConnectFrame = async (routerWin) => {
  if (!X || !blobHostWin) return;
  try {
    const hostname = os.hostname();
    const xblobLocalHostAtom = await X.InternAtom(false, 'XBLOB_X_SERVER_LOCAL_BLOB_HOST');
    const xblobLocalXBlobHostAtom = await X.InternAtom(false, 'XBLOB_X_SERVER_LOCAL_XBLOB_HOST');
    const busmasterHostWin = (await X.GetSelectionOwner(xblobLocalHostAtom)) || (await X.GetSelectionOwner(xblobLocalXBlobHostAtom)) || routerWin;

    if (!busmasterHostWin || busmasterHostWin === blobHostWin) {
      return;
    }

    const xblobHostConnectAtom = await X.InternAtom(false, 'XBLOB_HOST_CONNECT_V0');
    const socketPathAtom = await X.InternAtom(false, 'XBLOB_SOCKET_PATH');
    const hostNameAtom = await X.InternAtom(false, hostname);

    await xintent.XClientMessage(X, busmasterHostWin, xblobHostConnectAtom, [
      blobHostWin,
      blobHostWin,
      socketPathAtom,
      hostNameAtom,
    ]);

    logger.info(`Sent XBlobHostConnect XMessageFrame from secondary blobHostWin (0x${blobHostWin.toString(16)}) to master XBLOB_X_SERVER_LOCAL_BLOB_HOST (0x${busmasterHostWin.toString(16)})`);
  } catch (err) {
    logger.error(`Failed to send XBlobHostConnect XMessageFrame: ${err.message}`, err);
  }
};

module.exports = {
  init,
  sendHostConnectFrame,
  pickFilePath,
  pickFile,
  xblobBroadcast,
  xblobDestructor: handleXBlobDestructor,
  hostBlobs,
  softLinks,
};
