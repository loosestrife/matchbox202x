#!/usr/bin/env node
const { spawn } = require('child_process');
const xintent = require('./x11-promises/xintent');
const {
  connectToRouter,
  createClientWindow,
  parseXIntentIntentV0,
  XBlobRead,
  atoms,
  widString,
} = xintent;
const x11 = require('./x11-promises/x11-promises');

let currentClipboard = null; // Holds { type, _dataType, data, name }

/**
 * Converts an image buffer to a requested target format on-the-fly using `convert`
 */
async function convertImageBuffer(inputBuffer, targetFormat) {
  return new Promise((resolve, reject) => {
    // Format e.g. "image/jpeg" -> "jpeg", "image/png" -> "png"
    const fmt = targetFormat.replace('image/', '').replace('x-', '');
    const proc = spawn('convert', ['-', `${fmt}:-`]);

    const stdoutChunks = [];
    const stderrChunks = [];

    proc.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
      } else {
        const err = Buffer.concat(stderrChunks).toString();
        reject(new Error(`ImageMagick convert failed (exit code ${code}): ${err}`));
      }
    });

    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`'convert' (ImageMagick) is not installed. Run 'sudo apt install imagemagick' or 'pacman -S imagemagick'.`));
      } else {
        reject(new Error(`Failed to start 'convert': ${err.message}`));
      }
    });

    proc.stdin.write(inputBuffer);
    proc.stdin.end();
  });
}

/**
 * Writes data to an X11 window property in chunks to prevent 16-bit packet length overflow
 * (>65,535 bytes). Uses Mode 0 (Replace) for the first chunk, and Mode 2 (Append) for subsequent chunks.
 */
function changePropertyChunked(X, window, property, type, format, data, chunkSize = 60000) {
  if (data.length <= chunkSize) {
    X.ChangeProperty(0, window, property, type, format, data);
    return;
  }

  let offset = 0;
  let mode = 0; // 0 = Replace

  while (offset < data.length) {
    const end = Math.min(offset + chunkSize, data.length);
    const chunk = data.subarray(offset, end);
    X.ChangeProperty(mode, window, property, type, format, chunk);
    mode = 2; // 2 = Append
    offset = end;
  }
}

/**
 * Builds standard 32-byte X11 SelectionNotify event buffer (Opcode 31)
 */
function buildSelectionNotifyBuffer(time, requestor, selection, target, property) {
  const ev = Buffer.alloc(32);
  ev.writeInt8(31, 0);            // Event Opcode 31 = SelectionNotify
  ev.writeInt8(0, 1);             // Unused
  ev.writeUInt16LE(0, 2);         // Sequence Number
  ev.writeUInt32LE(time, 4);      // Timestamp
  ev.writeUInt32LE(requestor, 8); // Requestor Window XID
  ev.writeUInt32LE(selection, 12);// Selection Atom (CLIPBOARD)
  ev.writeUInt32LE(target, 16);   // Target Atom
  ev.writeUInt32LE(property, 20); // Property Atom (0 = Refused/Failed)
  return ev;
}

async function startDaemon() {
  const { X, root } = await x11.createClientWithPromises();
  await connectToRouter(X, root);

  if (!xintent.routerWin) {
    console.error('[copy-daemon] Error: Could not connect to XINTENT router.');
    process.exit(1);
  }

  // Create daemon window registered with _NET_WM_PID for XSECURE V0
  const daemonWin = await createClientWindow(X, root, 'ui.Copy-daemon');

  // 1. Intern X11 Protocol & Selection Atoms
  const atomList = [
    'XINTENT_MATCHBOX_TOML',
    'CLIPBOARD',
    'TARGETS',
    'ATOM',
    'UTF8_STRING',
    'STRING',
    'TEXT',
    'text/plain',
    'text/plain;charset=utf-8',
    'text/html',
    'image/png',
    'image/jpeg',
    'image/bmp',
    'image/webp',
    'image/gif',
  ];

  await Promise.all(
    atomList.map(async (name) => {
      atoms[name] = await X.InternAtom(false, name);
    })
  );

  // Fast reverse atom mapping for logging/lookups
  const atomNames = Object.fromEntries(
    Object.entries(atoms).map(([name, val]) => [val, name])
  );

  // 2. Advertise capabilities to matchbox router
  const matchboxToml = [
    '[intents."ui.Copy"]',
    'invocation = "X11"'
  ].join('\n');

  X.ChangeProperty(
    0,
    daemonWin,
    atoms.XINTENT_MATCHBOX_TOML,
    atoms.STRING,
    8,
    Buffer.from(matchboxToml)
  );

  console.log(`[copy-daemon] Online on window ${widString(daemonWin)} (Router: ${widString(xintent.routerWin)})`);

  // ---------------------------------------------------------------------------
  // X11 Event Listener: Handles both Intents & Selection Requests
  // ---------------------------------------------------------------------------
  X.on('event', async (ev) => {
    // -------------------------------------------------------------------------
    // A. Handle incoming `ui.Copy` Intent (ClientMessage Opcode 33)
    // -------------------------------------------------------------------------
    if (ev.type === 33 && ev.message_type === atoms.XINTENT_INTENT_V0) {
      try {
        const { senderWin, payload, txId } = await parseXIntentIntentV0(X, xintent.routerWin, ev);

        if (payload.intent === 'ui.Copy') {
          console.log(`\n[copy-daemon] Received ui.Copy intent from ${widString(senderWin)} (txId: ${txId})`);
          const contentAtom = payload.blob;
          const content = await XBlobRead(X, xintent.routerWin, contentAtom);

          currentClipboard = content;

          // Claim X11 CLIPBOARD selection owner
          X.SetSelectionOwner(daemonWin, atoms.CLIPBOARD);

          console.log('--------------------------------------------------');
          console.log(`📋 CLIPBOARD CLAIMED (atoms.CLIPBOARD)`);
          console.log(` - Source Window : ${widString(senderWin)}`);
          console.log(` - MIME Type     : ${content.type || 'unknown'}`);
          console.log(` - Blob Type     : ${content.xblobType || 'Blob'}`);
          if (content.name) console.log(` - File Name     : ${content.name}`);
          console.log(` - Size          : ${content.size ?? content.data?.length ?? 0} bytes`);
          console.log(` - Encoding      : ${content._dataType || 'text'}`);
          console.log('--------------------------------------------------');
        }
      } catch (err) {
        console.error('[copy-daemon] Error parsing incoming intent frame:', err.message);
      }
    }

    // -------------------------------------------------------------------------
    // B. Handle X11 ICCCM `SelectionRequest` (Opcode 30) from Paste Requesters
    // -------------------------------------------------------------------------
    if (ev.type === 30 && ev.selection === atoms.CLIPBOARD) {
      const requestor = ev.requestor;
      const targetAtom = ev.target;
      const targetName = atomNames[targetAtom] ?? `Atom(${targetAtom})`;
      const time = ev.time || 0;
      let targetProp = ev.property === 0 ? targetAtom : ev.property;

      console.log(`[copy-daemon] SelectionRequest from ${widString(requestor)} for target '${targetName}'`);

      if (!currentClipboard) {
        // Refuse request if clipboard is empty
        const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, 0);
        X.SendEvent(requestor, false, 0, notifyBuf);
        return;
      }

      const isImage = currentClipboard.type?.startsWith('image/');
      const isText = currentClipboard.type?.startsWith('text/') || currentClipboard._dataType === 'text';

      try {
        // ---------------------------------------------------------------------
        // 1. Target: TARGETS (Advertise supported target formats)
        // ---------------------------------------------------------------------
        if (targetAtom === atoms.TARGETS) {
          let supportedTargets = [atoms.TARGETS];

          if (isImage) {
            supportedTargets.push(
              atoms['image/png'],
              atoms['image/jpeg'],
              atoms['image/bmp'],
              atoms['image/webp'],
              atoms['image/gif']
            );
          } else if (isText) {
            supportedTargets.push(
              atoms.UTF8_STRING,
              atoms.STRING,
              atoms.TEXT,
              atoms['text/plain'],
              atoms['text/plain;charset=utf-8']
            );
            if (currentClipboard.type === 'text/html') {
              supportedTargets.push(atoms['text/html']);
            }
          }

          // Format 32 array of target Atom IDs
          const buf = Buffer.alloc(supportedTargets.length * 4);
          supportedTargets.forEach((atomId, idx) => buf.writeUInt32LE(atomId, idx * 4));

          changePropertyChunked(X, requestor, targetProp, atoms.ATOM, 32, buf);
          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          console.log(` -> Responded with ${supportedTargets.length} supported TARGETS`);
          return;
        }

        // ---------------------------------------------------------------------
        // 2. Target: Text Formats
        // ---------------------------------------------------------------------
        if (isText && [atoms.UTF8_STRING, atoms.STRING, atoms.TEXT, atoms['text/plain'], atoms['text/plain;charset=utf-8'], atoms['text/html']].includes(targetAtom)) {
          const textBuf = Buffer.from(currentClipboard.data || '', 'utf8');
          changePropertyChunked(X, requestor, targetProp, targetAtom, 8, textBuf);

          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          console.log(` -> Served text payload (${textBuf.length} bytes) as ${targetName}`);
          return;
        }

        // ---------------------------------------------------------------------
        // 3. Target: Image Formats (Native or On-The-Fly Conversion)
        // ---------------------------------------------------------------------
        if (isImage && targetName.startsWith('image/')) {
          let rawInputBuf = currentClipboard._dataType === 'base64'
            ? Buffer.from(currentClipboard.data, 'base64')
            : Buffer.from(currentClipboard.data, 'utf8');

          let outputBuf = rawInputBuf;

          // Check if format conversion is required (e.g. stored PNG -> requested JPEG)
          if (currentClipboard.type !== targetName) {
            console.log(` -> Converting image on-the-fly from ${currentClipboard.type} to ${targetName}...`);
            outputBuf = await convertImageBuffer(rawInputBuf, targetName);
          }

          // Chunk the payload to avoid X11 16-bit packet length overflow (>65,535 bytes)
          changePropertyChunked(X, requestor, targetProp, targetAtom, 8, outputBuf);

          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          console.log(` -> Served image payload (${outputBuf.length} bytes) as ${targetName}`);
          return;
        }

        // ---------------------------------------------------------------------
        // 4. Unsupported target requested -> Refuse
        // ---------------------------------------------------------------------
        console.warn(` -> Target '${targetName}' not supported for current clipboard type (${currentClipboard.type})`);
        const failNotifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, 0);
        X.SendEvent(requestor, false, 0, failNotifyBuf);

      } catch (err) {
        console.error(` -> Error fulfilling SelectionRequest for ${targetName}:`, err.message);
        const failNotifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, 0);
        X.SendEvent(requestor, false, 0, failNotifyBuf);
      }
    }
  });
}

startDaemon().catch((err) => {
  console.error('[copy-daemon] Fatal error:', err);
  process.exit(1);
});