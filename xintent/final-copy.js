#!/usr/bin/env node
// usage:
// $ cat cat.png | final-copy.js --type image/png             # Stdin Blob
// $ final-copy.js --type text/html --echo "<b>html</b>"     # Explicit String
// $ final-copy.js cat.png                                   # File path

const fs = require('fs');
const path = require('path');
const { connectToRouter, createClientWindow, sendXIntentIntentV0, XBlobCreate, XBlobTransfer } = require('./util/xintent');
const x11 = require('./util/x11-promises');

const MIME_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

async function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function main() {
  const args = process.argv.slice(2);
  let typeArg = null;
  let echoArg = null;
  let fileArg = null;
  let positionalArg = null;

  // Explicit CLI Flag Parsing
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--type' || args[i] === '-t') && args[i + 1]) {
      typeArg = args[i + 1];
      i++;
    } else if ((args[i] === '--echo' || args[i] === '-e') && args[i + 1]) {
      echoArg = args[i + 1];
      i++;
    } else if ((args[i] === '--file' || args[i] === '-f') && args[i + 1]) {
      fileArg = args[i + 1];
      i++;
    } else if (!positionalArg) {
      positionalArg = args[i];
    }
  }

  const stdinData = await readStdin();
  let xblobPayload = null;

  if (echoArg !== null) {
    // 1. Explicit string mode via --echo / -e
    const textBuf = Buffer.from(echoArg, 'utf8');
    const mimeType = typeArg || 'text/plain';
    xblobPayload = {
      xblobType: 'Blob',
      type: mimeType,
      size: textBuf.length,
      _dataType: 'text',
      data: echoArg,
    };
  } else if (stdinData && stdinData.length > 0) {
    // 2. Piped input mode via Stdin
    const mimeType = typeArg || 'text/plain';
    const isText = mimeType.startsWith('text/') || mimeType === 'application/json';
    
    xblobPayload = {
      xblobType: 'Blob',
      type: mimeType,
      size: stdinData.length,
      _dataType: isText ? 'text' : 'base64',
      data: isText ? stdinData.toString('utf8') : stdinData.toString('base64'),
    };
  } else if (fileArg || (positionalArg && fs.existsSync(positionalArg))) {
    // 3. File mode (explicit --file or existing file path)
    const filePath = fileArg || positionalArg;
    const fileBuf = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mimeType = typeArg || getMimeType(filePath);
    const isText = mimeType.startsWith('text/') || mimeType === 'application/json';

    xblobPayload = {
      xblobType: 'File',
      name: fileName,
      type: mimeType,
      size: fileBuf.length,
      _dataType: isText ? 'text' : 'base64',
      data: isText ? fileBuf.toString('utf8') : fileBuf.toString('base64'),
    };
  } else if (positionalArg) {
    // 4. Positional string fallback
    const textBuf = Buffer.from(positionalArg, 'utf8');
    xblobPayload = {
      xblobType: 'Blob',
      type: typeArg || 'text/plain',
      size: textBuf.length,
      _dataType: 'text',
      data: positionalArg,
    };
  } else {
    console.error('Error: No input provided via --echo, stdin, or positional arguments.');
    process.exit(1);
  }

  // X11 Connection & Window Initialization
  const { X, root } = await x11.createClientWithPromises();
  const routerWin = await connectToRouter(X, root);
  if (!routerWin) {
    console.error('Error: Could not connect to XINTENT router.');
    process.exit(1);
  }

  // Create client window with _NET_WM_PID for XSECURE V0
  const clientWin = await createClientWindow(X, root, 'cli-clipboard');

  // Step A: Create XBLOB V0 holding content payload
  const dataBlobAtom = await XBlobCreate(X, routerWin, clientWin, xblobPayload);

  // Step B: Transfer ownership of content blob to routerWin
  XBlobTransfer(X, routerWin, clientWin, dataBlobAtom, routerWin);

  // Step C: Dispatch ui.Copy intent referencing dataBlobAtom
  console.log("blob transferred.  sending intent");
  await sendXIntentIntentV0(X, routerWin, {
    senderWin: clientWin,
    payload: {
      intent: 'ui.Copy',
      blob: dataBlobAtom,
    },
  });

  console.log(`[ui.Copy] Successfully copied ${xblobPayload.xblobType} (${xblobPayload.type}) to clipboard.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[ui.Copy] Error:', err);
  process.exit(1);
});