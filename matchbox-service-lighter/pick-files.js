//matchbox-service-lighter/pick-files.js
const { isUtf8 } = require('node:buffer');
const fs = require("fs");
const os = require("os");
const path = require("path");
const xintent = require("../x11-promises/xintent");

const softLinks = {};

const pickFilePath = async xiIntent => {
  const payload = xiIntent.payload;
  const pathname = await execShell("zenity --file-selection");
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
    payload: {
      event: "fs.PickFileResponse",
      disposition: "final",
    },
    dataBlob,
  });
};
const pickFile = async (xiIntent) => {
  const payload = xiIntent.payload;
  const pathname = await execShell("zenity --file-selection");
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
    softLinks[dataBlob] = pathname; // hey thats not a fd...
  }
  xintent.XBlobTransfer(X, xintent.routerWin, lighterWin, dataBlob, xintent.routerWin);
  await xintent.sendXIntentEventV0(X, xintent.routerWin, {
    targetWin: xintent.routerWin,
    senderWin: lighterWin,
    channel: xiIntent.channel,
    payload: {
      event: "fs.PickFileResponse",
      disposition: "final",
    },
    dataBlob,
  });
};

const xblobBroadcast = async message => {
  const data = XBlobRead(X, xintent.routerWin, message.blob, message.host, message.version);
  let buf;
  if(data._dataType == 'text'){
    buf = Buffer.from(data.data, 'utf-8')
  }
  if(data._dataType == 'base64'){
    buf = Buffer.from(data.data, 'base64')
  }
  fs.writeFileSync(softLinks[message.blob], buf);
}

const xblobDestructor = async message => {
  const blob = message.blob;
  delete softLinks[blob];
  xintent.XBlobSoftUnlink(X, xintent.routerWin, lighterWin, blob);
};

function execShell(command) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, {
      shell: true,
      stdio: ['ignore', 'pipe', 'inherit']
    });

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
const init = g => {
  X = g.X;
  lighterWin = g.lighetWin;
};

module.exports = {
  init,
  pickFilePath,
  pickFile,
  xblobDestructor,
  xblobBroadcast,
};
