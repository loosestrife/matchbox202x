#!/usr/bin/env bun
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const xintent = require('../x11-promises/xintent');
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
const x11 = require('../x11-promises/x11-promises');

let currentClipboard = null; // Holds { type, _dataType, data, name, rawBuf, filePath, fileUri }

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
    const propAtom = atoms.MATCHBOX_TOML;
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
    'MATCHBOX_TOML',
    'CLIPBOARD',
    'TARGETS',
    'ATOM',
    'UTF8_STRING',
    'STRING',
    'TEXT',
    'text/plain',
    'text/plain;charset=utf-8',
    'text/html',
    'text/uri-list',
    'x-special/gnome-copied-files',
    'application/octet-stream',
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

  // 1. Advertise capabilities to matchbox router for ui.Copy, ui.Paste, and fs.SendTo
  const matchboxToml = `
[app]
id = "cool-clips"

[intents]
"fs.SendTo" = true
"fs.SaveAs" = true

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
    atoms.MATCHBOX_TOML,
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

        // --- Handle ui.Copy / fs.SendTo / fs.SaveAs ---
        if (payload.intent === 'ui.Copy' || payload.intent === 'fs.SendTo' || payload.intent === 'fs.SaveAs') {
          console.log(`\n[copy-daemon] Received ${payload.intent} intent from ${widString(senderWin)} (channel: ${channel})`);
          const contentAtom = payload.blob || (ev.data && ev.data[4] ? ev.data[4] : undefined);
          if (!contentAtom) {
            console.error(`[copy-daemon] Error: No content blob atom specified in ${payload.intent} frame`);
            return;
          }
          const content = await XBlobRead(X, xintent.routerWin, contentAtom, undefined, undefined, 0, 'cool-clips', { receiveFd: true });

          // Extract raw binary Buffer safely
          let rawBuf;
          if (Buffer.isBuffer(content.data)) {
            rawBuf = content.data;
          } else if (typeof content.data === 'number' && content.data >= 0) {
            rawBuf = fs.readFileSync(`/proc/self/fd/${content.data}`);
          } else if (typeof content.data === 'string' && (content._dataType === 'fd-rights' || content._dataType === 'file-path' || content.contentEncoding === 'fd-rights' || content.contentEncoding === 'file-path' || content.data.startsWith('/proc/')) && fs.existsSync(content.data)) {
            rawBuf = fs.readFileSync(content.data);
          } else if (content._dataType === 'base64' || (typeof content.data === 'string' && content.data.startsWith('data:'))) {
            const b64Str = content.data.includes(',') ? content.data.split(',')[1] : content.data;
            rawBuf = Buffer.from(b64Str, 'base64');
          } else {
            rawBuf = Buffer.from(content.data || '', 'utf8');
          }

          // Persist file payload to disk for file manager paste (text/uri-list)
          const clipDir = '/tmp/xintent_clipboard';
          let filePath;
          if (content.url && content.url.startsWith('file://')) {
            try {
              const parsedPath = new URL(content.url).pathname;
              if (fs.existsSync(parsedPath)) filePath = parsedPath;
            } catch (_) {}
          }
          if (!filePath && typeof content.data === 'number' && content.data >= 0) {
            filePath = `/proc/self/fd/${content.data}`;
          }
          if (!filePath && typeof content.data === 'string' && fs.existsSync(content.data)) {
            filePath = content.data;
          }
          if (!filePath) {
            if (!fs.existsSync(clipDir)) fs.mkdirSync(clipDir, { recursive: true });
            const fileName = content.name || payload.name || `shared_file_${Date.now()}`;
            filePath = path.join(clipDir, fileName);
            fs.writeFileSync(filePath, rawBuf);
          }

          content.rawBuf = rawBuf;
          content.filePath = filePath;
          content.fileUri = `file://${filePath}`;

          currentClipboard = content;
          X.SetSelectionOwner(daemonWin, atoms.CLIPBOARD);

          console.log('--------------------------------------------------');
          console.log(`📋 CLIPBOARD CLAIMED via ${payload.intent} (atoms.CLIPBOARD)`);
          console.log(` - File Name     : ${fileName}`);
          console.log(` - File Path     : ${filePath}`);
          console.log(` - MIME Type     : ${content.type || 'unknown'}`);
          console.log(` - Size          : ${rawBuf.length} bytes`);
          console.log('--------------------------------------------------');
        }

        if (payload.intent == 'ui.TextProcess') {
          console.log(`\n[copy-daemon] Received ui.TextProcess intent from ${widString(senderWin)} (channel: ${channel})`);
          const rawBuf = Buffer.from(payload.text || '', 'utf8');
          currentClipboard = {
            type: 'text/plain',
            data: payload.text,
            rawBuf: rawBuf,
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

          await sendXIntentEventV0(X, xintent.routerWin, {
            senderWin: daemonWin,
            channel,
            controlWord: 2, // FIN bit to close channel stream
            dataBlob,
            payload: {
              event: 'ui.PasteResponse',
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
      const isText = currentClipboard.type?.startsWith('text/') || currentClipboard._dataType === 'text' || currentClipboard._dataType === 'fd-rights';

      try {
        if (targetAtom === atoms.TARGETS) {
          let supportedTargets = [
            atoms.TARGETS,
            atoms.UTF8_STRING,
            atoms.STRING,
            atoms.TEXT,
            atoms['text/plain'],
            atoms['text/plain;charset=utf-8'],
          ];

          if (currentClipboard.fileUri) {
            if (atoms['text/uri-list']) supportedTargets.push(atoms['text/uri-list']);
            if (atoms['x-special/gnome-copied-files']) supportedTargets.push(atoms['x-special/gnome-copied-files']);
          }

          if (isImage) {
            supportedTargets.push(
              atoms['image/png'],
              atoms['image/jpeg'],
              atoms['image/bmp'],
              atoms['image/webp'],
              atoms['image/gif']
            );
          }

          if (currentClipboard.type && atoms[currentClipboard.type] && !supportedTargets.includes(atoms[currentClipboard.type])) {
            supportedTargets.push(atoms[currentClipboard.type]);
          }

          const buf = Buffer.alloc(supportedTargets.length * 4);
          supportedTargets.forEach((atomId, idx) => buf.writeUInt32LE(atomId, idx * 4));

          changePropertyChunked(X, requestor, targetProp, atoms.ATOM, 32, buf);
          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          return;
        }

        if (targetAtom === atoms['text/uri-list'] || targetName === 'text/uri-list') {
          const uriListBuf = Buffer.from(`${currentClipboard.fileUri || ''}\r\n`, 'utf8');
          changePropertyChunked(X, requestor, targetProp, targetAtom, 8, uriListBuf);
          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          return;
        }

        if (targetAtom === atoms['x-special/gnome-copied-files'] || targetName === 'x-special/gnome-copied-files') {
          const gnomeBuf = Buffer.from(`copy\r\n${currentClipboard.fileUri || ''}\r\n`, 'utf8');
          changePropertyChunked(X, requestor, targetProp, targetAtom, 8, gnomeBuf);
          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          return;
        }

        if ((isImage && targetName.startsWith('image/')) || (targetName === currentClipboard.type && !targetName.startsWith('text/')) || targetName === 'application/octet-stream') {
          let rawInputBuf = currentClipboard.rawBuf;
          if (!Buffer.isBuffer(rawInputBuf)) {
            if (currentClipboard._dataType === 'base64' || (typeof currentClipboard.data === 'string' && currentClipboard.data.startsWith('data:'))) {
              const b64 = currentClipboard.data.includes(',') ? currentClipboard.data.split(',')[1] : currentClipboard.data;
              rawInputBuf = Buffer.from(b64, 'base64');
            } else {
              rawInputBuf = Buffer.from(currentClipboard.data || '', 'utf8');
            }
          }

          let outputBuf = rawInputBuf;
          if (isImage && targetName.startsWith('image/') && currentClipboard.type !== targetName) {
            try {
              outputBuf = await convertImageBuffer(rawInputBuf, targetName);
            } catch (_) {
              outputBuf = rawInputBuf;
            }
          }

          changePropertyChunked(X, requestor, targetProp, targetAtom, 8, outputBuf);
          const notifyBuf = buildSelectionNotifyBuffer(time, requestor, atoms.CLIPBOARD, targetAtom, targetProp);
          X.SendEvent(requestor, false, 0, notifyBuf);
          return;
        }

        if ([atoms.UTF8_STRING, atoms.STRING, atoms.TEXT, atoms['text/plain'], atoms['text/plain;charset=utf-8'], atoms['text/html']].includes(targetAtom)) {
          let textBuf = Buffer.alloc(0);
          const targetFilePath = currentClipboard.filePath || currentClipboard.data;
          if (typeof targetFilePath === 'string' && (targetFilePath.startsWith('/proc/') || targetFilePath.startsWith('/tmp/') || targetFilePath.startsWith('/dev/')) && fs.existsSync(targetFilePath)) {
            textBuf = fs.readFileSync(targetFilePath);
          } else if (isText) {
            textBuf = Buffer.from(currentClipboard.data || '', 'utf8');
          } else if (currentClipboard.fileUri) {
            textBuf = Buffer.from(currentClipboard.fileUri, 'utf8');
          } else if (currentClipboard.rawBuf) {
            textBuf = currentClipboard.rawBuf;
          } else {
            textBuf = Buffer.from(String(currentClipboard.data || ''), 'utf8');
          }

          changePropertyChunked(X, requestor, targetProp, targetAtom, 8, textBuf);
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
