#!/usr/bin/env node
const { spawn } = require('child_process');
const xintent = require('./x11-promises/xintent');
const {
  connectToRouter,
  createClientWindow,
  parseXIntentIntentV0,
  XBlobCreate,
  XBlobRead,
  sendXIntentEventV0,
  sendXIntentIntentV0,
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
        reject(new Error(`'convert' (ImageMagick) is not installed.`));
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

/**
 * Requests and fetches active X11 CLIPBOARD data from remote windows if cool-clips is not selection owner
 */
async function fetchRemoteX11Clipboard(X, daemonWin, targetAtom) {
  return new Promise((resolve) => {
    const propAtom = atoms.XINTENT_MATCHBOX_TOML; // Reuse existing known atom for property buffer
    let timeoutId = null;

    const selectionHandler = async (ev) => {
      if (ev.type === 31 && ev.requestor === daemonWin) { // SelectionNotify
        clearTimeout(timeoutId);
        X.removeListener('event', selectionHandler);

        if (ev.property === 0) {
          return resolve(null); // Refused by owner
        }

        try {
          const propData = await X.GetProperty(0, daemonWin, propAtom, 0, 0, 10000000); // Read property data
          X.DeleteProperty(daemonWin, propAtom);
          resolve(propData.data);
        } catch {
          resolve(null);
        }
      }
    };

    X.on('event', selectionHandler);

    // Timeout safety if selection owner doesn't respond
    timeoutId = setTimeout(() => {
      X.removeListener('event', selectionHandler);
      resolve(null);
    }, 1000);

    X.ConvertSelection(daemonWin, atoms.CLIPBOARD, targetAtom, propAtom, 0);
  });
}

/**
 * Returns current clipboard object, falling back to reading active X11 Selection Owner
 */
async function getActiveClipboardData(X, daemonWin) {
  const owner = await X.GetSelectionOwner(atoms.CLIPBOARD);
  
  if (owner === daemonWin && currentClipboard) {
    return currentClipboard;
  }

  if (owner !== 0) {
    const remoteData = await fetchRemoteX11Clipboard(X, daemonWin, atoms.UTF8_STRING);
    if (remoteData && remoteData.length > 0) {
      return {
        type: 'text/plain',
        data: remoteData.toString('utf8'),
        _dataType: 'text',
      };
    }
  }

  return currentClipboard || { type: 'text/plain', data: '', _dataType: 'text' };
}

async function startDaemon() {
  const { X, root } = await x11.createClientWithPromises();
  await connectToRouter(X, root);

  if (!xintent.routerWin) {
    console.error('[copy-daemon] Error: Could not connect to XINTENT router.');
    process.exit(1);
  }

  const daemonWin = await createClientWindow(X, root, 'ui.Copy-daemon');

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

  const atomNames = Object.fromEntries(
    Object.entries(atoms).map(([name, val]) => [val, name])
  );

  // 1. Advertise capabilities to matchbox router for both ui.Copy and ui.Paste
  const matchboxToml = `
[intents."ui.Copy"]
invocation = "X11"

[intents."ui.Paste"]
invocation = "X11"

[intents."ui.TextProcess"]
invocation = "X11"
`;

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
  // X11 Event Listener: Handles Intents & Selection Requests
  // ---------------------------------------------------------------------------
  X.on('event', async (ev) => {
    // -------------------------------------------------------------------------
    // A. Handle incoming Intents (Opcode 33)
    // -------------------------------------------------------------------------
    if (ev.type === 33 && ev.message_type === atoms.XINTENT_INTENT_V0) {
      try {
        const { senderWin, payload, channel } = await parseXIntentIntentV0(X, xintent.routerWin, ev);

        // --- Handle ui.Copy ---
        if (payload.intent === 'ui.Copy') {
          console.log(`\n[copy-daemon] Received ui.Copy intent from ${widString(senderWin)} (channel: ${channel})`);
          const contentAtom = payload.blob;
          const content = await XBlobRead(X, xintent.routerWin, contentAtom);

          currentClipboard = content;
          X.SetSelectionOwner(daemonWin, atoms.CLIPBOARD);

          console.log('--------------------------------------------------');
          console.log(`📋 CLIPBOARD CLAIMED (atoms.CLIPBOARD)`);
          console.log(` - MIME Type     : ${content.type || 'unknown'}`);
          console.log(` - Encoding      : ${content._dataType || 'text'}`);
          console.log('--------------------------------------------------');
        }

        if (payload.intent == 'ui.TextProcess') {
          console.log(`\n[copy-daemon] Received ui.TextProcess intent from ${widString(senderWin)} (channel: ${channel})`);
          currentClipboard = {
            type: 'text/plain',
            data: payload.text,
            _dataType: 'text' 
          };
          X.SetSelectionOwner(daemonWin, atoms.CLIPBOARD);

          console.log('--------------------------------------------------');
          console.log(`📋 CLIPBOARD CLAIMED (atoms.CLIPBOARD)`);
          console.log(` ${payload.text}`);
          console.log('--------------------------------------------------');
        }

        // --- Handle ui.Paste ---
        if (payload.intent === 'ui.Paste') {
          console.log(`\n[copy-daemon] Received ui.Paste intent from ${widString(senderWin)} (channel: ${channel})`);
          
          const clipPayload = await getActiveClipboardData(X, daemonWin);
          const dataBlob = await XBlobCreate(X, xintent.routerWin, daemonWin, clipPayload);

          await sendXIntentIntentV0(X, xintent.routerWin, {
            senderWin: daemonWin,
            channel,
            dataBlob,
            payload: {
              intent: 'ui.PasteResponse',
              disposition: 'final',
            }
          });

          console.log(` -> Responded to ui.Paste with data atom 0x${dataBlob.toString(16)} (${clipPayload.type})`);
        }
      } catch (err) {
        console.error('[copy-daemon] Error handling intent frame:', err.message);
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

      if (!currentClipboard) {
        const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, 0);
        X.SendEvent(requestor, false, 0, notifyBuf);
        return;
      }

      const isImage = currentClipboard.type?.startsWith('image/');
      const isText = currentClipboard.type?.startsWith('text/') || currentClipboard._dataType === 'text';

      try {
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

          const buf = Buffer.alloc(supportedTargets.length * 4);
          supportedTargets.forEach((atomId, idx) => buf.writeUInt32LE(atomId, idx * 4));

          changePropertyChunked(X, requestor, targetProp, atoms.ATOM, 32, buf);
          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          return;
        }

        if (isText && [atoms.UTF8_STRING, atoms.STRING, atoms.TEXT, atoms['text/plain'], atoms['text/plain;charset=utf-8'], atoms['text/html']].includes(targetAtom)) {
          const textBuf = Buffer.from(currentClipboard.data || '', 'utf8');
          changePropertyChunked(X, requestor, targetProp, targetAtom, 8, textBuf);

          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          return;
        }

        if (isImage && targetName.startsWith('image/')) {
          let rawInputBuf = currentClipboard._dataType === 'base64'
            ? Buffer.from(currentClipboard.data, 'base64')
            : Buffer.from(currentClipboard.data, 'utf8');

          let outputBuf = rawInputBuf;
          if (currentClipboard.type !== targetName) {
            outputBuf = await convertImageBuffer(rawInputBuf, targetName);
          }

          changePropertyChunked(X, requestor, targetProp, targetAtom, 8, outputBuf);
          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          return;
        }

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