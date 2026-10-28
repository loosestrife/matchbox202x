#!/usr/bin/env bun
const path = require('path');
const xintent = require(path.join(__dirname, 'x11-promises', 'xintent'));
const {
  connectToRouter,
  createClientWindow,
  parseXIntentIntentV0,
  XBlobCreate,
  XBlobRead,
  sendXIntentEventV0,
  atoms,
  widString,
} = xintent;
const x11 = require(path.join(__dirname, 'x11-promises', 'x11-promises'));
const {
  changePropertyChunked,
  buildSelectionNotifyBuffer,
  sendSelectionNotify,
  extractRawBufferFromContent,
  persistClipboardFile,
  buildSupportedTargetsList,
  resolveBinarySelectionBuffer,
  resolveTextSelectionBuffer,
} = require(path.join(__dirname, 'cool-clips', 'clipboard-handlers'));

let currentClipboard = null; // Holds { type, _dataType, data, name, rawBuf, filePath, fileUri }
const clipboardHistory = [];

const ATOM_LIST = [
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

const MATCHBOX_TOML_MANIFEST = `
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

/**
 * Requests and fetches active X11 CLIPBOARD data from remote windows if cool-clips is not selection owner
 */
async function fetchRemoteX11Clipboard(X, daemonWin, targetAtom) {
  return new Promise((resolve) => {
    const propAtom = atoms.MATCHBOX_TOML;
    let timeoutId = null;

    const handleSelectionNotify = async (ev) => {
      if (ev.type !== 31 || ev.requestor !== daemonWin) return;
      clearTimeout(timeoutId);
      X.removeListener('event', handleSelectionNotify);

      if (ev.property === 0) {
        return resolve(null);
      }

      try {
        const propData = await X.GetProperty(0, daemonWin, propAtom, 0, 0, 10000000);
        X.DeleteProperty(daemonWin, propAtom);
        resolve(propData.data);
      } catch {
        resolve(null);
      }
    };

    X.on('event', handleSelectionNotify);

    timeoutId = setTimeout(() => {
      X.removeListener('event', handleSelectionNotify);
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

async function handleCopyOrSendToIntent(ctx) {
  const { X, daemonWin, senderWin, payload, channel, ev } = ctx;
  console.log(`\n[copy-daemon] Received ${payload.intent} intent from ${widString(senderWin)} (channel: ${channel})`);
  const contentAtom = payload.blob || (ev.data && ev.data[4] ? ev.data[4] : undefined);
  if (!contentAtom) {
    console.error(`[copy-daemon] Error: No content blob atom specified in ${payload.intent} frame`);
    return;
  }

  const content = await XBlobRead(X, xintent.routerWin, contentAtom, undefined, undefined, 0, 'cool-clips', { receiveFd: true });
  const rawBuf = extractRawBufferFromContent(content);
  const { fileName, filePath } = persistClipboardFile(content, payload.name, rawBuf);

  content.rawBuf = rawBuf;
  content.filePath = filePath;
  content.fileUri = `file://${filePath}`;

  currentClipboard = content;
  clipboardHistory.push(content);
  X.SetSelectionOwner(daemonWin, atoms.CLIPBOARD);

  console.log('--------------------------------------------------');
  console.log(`📋 CLIPBOARD CLAIMED via ${payload.intent} (atoms.CLIPBOARD)`);
  console.log(` - File Name     : ${fileName}`);
  console.log(` - File Path     : ${filePath}`);
  console.log(` - MIME Type     : ${content.type || 'unknown'}`);
  console.log(` - Size          : ${rawBuf.length} bytes`);
  console.log('--------------------------------------------------');
}

async function handleTextProcessIntent(ctx) {
  const { X, daemonWin, senderWin, payload, channel } = ctx;
  console.log(`\n[copy-daemon] Received ui.TextProcess intent from ${widString(senderWin)} (channel: ${channel})`);
  const rawBuf = Buffer.from(payload.text || '', 'utf8');
  currentClipboard = {
    type: 'text/plain',
    data: payload.text,
    rawBuf: rawBuf,
    _dataType: 'text',
  };
  clipboardHistory.push(currentClipboard);
  X.SetSelectionOwner(daemonWin, atoms.CLIPBOARD);

  console.log('--------------------------------------------------');
  console.log(`📋 CLIPBOARD CLAIMED (atoms.CLIPBOARD)`);
  console.log(` ${payload.text}`);
  console.log('--------------------------------------------------');
}

async function handlePasteIntent(ctx) {
  const { X, daemonWin, senderWin, channel } = ctx;
  console.log(`\n[copy-daemon] Received ui.Paste intent from ${widString(senderWin)} (channel: ${channel})`);

  const clipPayload = await getActiveClipboardData(X, daemonWin);
  const dataBlob = await XBlobCreate(X, xintent.routerWin, daemonWin, clipPayload);

  await sendXIntentEventV0(X, xintent.routerWin, {
    senderWin: daemonWin,
    channel,
    controlWord: 2,
    dataBlob,
    payload: {
      event: 'ui.PasteResponse',
      disposition: 'final',
    },
  });

  console.log(` -> Responded to ui.Paste with data atom 0x${dataBlob.toString(16)} (${clipPayload.type})`);
}

async function handleAppendIntent(ctx) {
  const { X, daemonWin, payload } = ctx;
  const existingText = currentClipboard?.data ? String(currentClipboard.data) : '';
  const appended = existingText + (payload.text || '');
  await handleTextProcessIntent({ ...ctx, payload: { ...payload, text: appended } });
  X.SetSelectionOwner(daemonWin, atoms.CLIPBOARD);
}

async function handleClearClipboardIntent() {
  currentClipboard = null;
  clipboardHistory.length = 0;
}

async function handleGetClipboardHistoryIntent(ctx) {
  const { X, daemonWin, channel } = ctx;
  await sendXIntentEventV0(X, xintent.routerWin, {
    senderWin: daemonWin,
    channel,
    controlWord: 2,
    payload: {
      event: 'clipboard.GetClipboardHistoryResponse',
      history: clipboardHistory.map((item) => ({ type: item.type, name: item.name })),
      disposition: 'final',
    },
  });
}

const INTENT_DISPATCH_MAP = {
  'ui.Copy': handleCopyOrSendToIntent,
  'fs.SendTo': handleCopyOrSendToIntent,
  'fs.SaveAs': handleCopyOrSendToIntent,
  'clipboard.Copy': handleCopyOrSendToIntent,
  'clipboard.Cut': handleCopyOrSendToIntent,
  'ui.TextProcess': handleTextProcessIntent,
  'clipboard.Append': handleAppendIntent,
  'ui.Paste': handlePasteIntent,
  'clipboard.Paste': handlePasteIntent,
  'clipboard.ClearClipboard': handleClearClipboardIntent,
  'clipboard.GetClipboardHistory': handleGetClipboardHistoryIntent,
};

async function handleIntentClientMessage(X, daemonWin, ev) {
  try {
    const { senderWin, payload, channel } = await parseXIntentIntentV0(X, xintent.routerWin, ev);
    const handler = INTENT_DISPATCH_MAP[payload.intent];
    if (handler) {
      await handler({ X, daemonWin, senderWin, payload, channel, ev });
    }
  } catch (err) {
    console.error('[copy-daemon] Error handling intent frame:', err.message);
  }
}

function isBinaryOrImageTarget(clip, targetName) {
  const isImage = clip.type?.startsWith('image/');
  if (isImage && targetName.startsWith('image/')) return true;
  if (targetName === clip.type && !targetName.startsWith('text/')) return true;
  return targetName === 'application/octet-stream';
}

function isTextTargetAtom(targetAtom) {
  const textAtoms = [
    atoms.UTF8_STRING,
    atoms.STRING,
    atoms.TEXT,
    atoms['text/plain'],
    atoms['text/plain;charset=utf-8'],
    atoms['text/html'],
  ];
  return textAtoms.includes(targetAtom);
}

async function fulfillSelectionTarget(X, requestor, targetAtom, targetName, targetProp) {
  if (targetAtom === atoms.TARGETS) {
    const supportedTargets = buildSupportedTargetsList(atoms, currentClipboard);
    const buf = Buffer.alloc(supportedTargets.length * 4);
    supportedTargets.forEach((atomId, idx) => buf.writeUInt32LE(atomId, idx * 4));
    changePropertyChunked(X, requestor, targetProp, atoms.ATOM, 32, buf);
    return true;
  }

  if (targetAtom === atoms['text/uri-list'] || targetName === 'text/uri-list') {
    const uriListBuf = Buffer.from(`${currentClipboard.fileUri || ''}\r\n`, 'utf8');
    changePropertyChunked(X, requestor, targetProp, targetAtom, 8, uriListBuf);
    return true;
  }

  if (targetAtom === atoms['x-special/gnome-copied-files'] || targetName === 'x-special/gnome-copied-files') {
    const gnomeBuf = Buffer.from(`copy\r\n${currentClipboard.fileUri || ''}\r\n`, 'utf8');
    changePropertyChunked(X, requestor, targetProp, targetAtom, 8, gnomeBuf);
    return true;
  }

  if (isBinaryOrImageTarget(currentClipboard, targetName)) {
    const outputBuf = await resolveBinarySelectionBuffer(currentClipboard, targetName);
    changePropertyChunked(X, requestor, targetProp, targetAtom, 8, outputBuf);
    return true;
  }

  if (isTextTargetAtom(targetAtom)) {
    const textBuf = resolveTextSelectionBuffer(currentClipboard);
    changePropertyChunked(X, requestor, targetProp, targetAtom, 8, textBuf);
    return true;
  }

  return false;
}

async function handleSelectionRequest(X, atomNames, ev) {
  const requestor = ev.requestor;
  const targetAtom = ev.target;
  const targetName = atomNames[targetAtom] ?? `Atom(${targetAtom})`;
  const time = ev.time || 0;
  const targetProp = ev.property === 0 ? targetAtom : ev.property;

  if (!currentClipboard) {
    sendSelectionNotify(X, time, requestor, atoms.CLIPBOARD, targetAtom, 0);
    return;
  }

  try {
    const handled = await fulfillSelectionTarget(X, requestor, targetAtom, targetName, targetProp);
    sendSelectionNotify(X, time, requestor, atoms.CLIPBOARD, targetAtom, handled ? targetProp : 0);
  } catch (err) {
    console.error(` -> Error fulfilling SelectionRequest for ${targetName}:`, err.message);
    sendSelectionNotify(X, time, requestor, atoms.CLIPBOARD, targetAtom, 0);
  }
}

function handleSelectionClear() {
  // Retains cached currentClipboard for fallback while acknowledging X11 SelectionClear
}

async function startDaemon() {
  const { X, root } = await x11.createClientWithPromises();
  await connectToRouter(X, root);

  if (!xintent.routerWin) {
    console.error('[copy-daemon] Error: Could not connect to XINTENT router.');
    process.exit(1);
  }

  const daemonWin = await createClientWindow(X, root, 'ui.Copy-daemon');

  await Promise.all(
    ATOM_LIST.map(async (name) => {
      atoms[name] = await X.InternAtom(false, name);
    })
  );

  const atomNames = Object.fromEntries(
    Object.entries(atoms).map(([name, val]) => [val, name])
  );

  X.ChangeProperty(
    0,
    daemonWin,
    atoms.MATCHBOX_TOML,
    atoms.STRING,
    8,
    Buffer.from(MATCHBOX_TOML_MANIFEST)
  );

  console.log(`[copy-daemon] Online on window ${widString(daemonWin)} (Router: ${widString(xintent.routerWin)})`);

  X.on('event', async (ev) => {
    if (ev.type === 33 && ev.message_type === atoms.XINTENT_INTENT_V0) {
      await handleIntentClientMessage(X, daemonWin, ev);
    } else if (ev.type === 30 && ev.selection === atoms.CLIPBOARD) {
      await handleSelectionRequest(X, atomNames, ev);
    } else if (ev.type === 29 && ev.selection === atoms.CLIPBOARD) {
      handleSelectionClear(ev);
    }
  });
}

startDaemon().catch((err) => {
  console.error('[copy-daemon] Fatal error:', err);
  process.exit(1);
});
