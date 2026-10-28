const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
      const msg = err.code === 'ENOENT'
        ? `'convert' (ImageMagick) is not installed.`
        : `Failed to start 'convert': ${err.message}`;
      reject(new Error(msg));
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

function sendSelectionNotify(X, time, requestor, selection, targetAtom, targetProp) {
  const notifyBuf = buildSelectionNotifyBuffer(time, requestor, selection, targetAtom, targetProp);
  X.SendEvent(requestor, false, 0, notifyBuf);
}

function isFileBackedData(content) {
  if (typeof content.data !== 'string') return false;
  const hasFdEncoding = (
    content._dataType === 'fd-rights' ||
    content._dataType === 'file-path' ||
    content.contentEncoding === 'fd-rights' ||
    content.contentEncoding === 'file-path' ||
    content.data.startsWith('/proc/')
  );
  return hasFdEncoding && fs.existsSync(content.data);
}

function extractRawBufferFromContent(content) {
  if (Buffer.isBuffer(content.data)) {
    return content.data;
  }
  if (typeof content.data === 'number' && content.data >= 0) {
    return fs.readFileSync(`/proc/self/fd/${content.data}`);
  }
  if (isFileBackedData(content)) {
    return fs.readFileSync(content.data);
  }
  if (content._dataType === 'base64' || (typeof content.data === 'string' && content.data.startsWith('data:'))) {
    const b64Str = content.data.includes(',') ? content.data.split(',')[1] : content.data;
    return Buffer.from(b64Str, 'base64');
  }
  return Buffer.from(content.data || '', 'utf8');
}

function resolveExistingFilePath(content) {
  if (content.url && content.url.startsWith('file://')) {
    try {
      const parsedPath = new URL(content.url).pathname;
      if (fs.existsSync(parsedPath)) return parsedPath;
    } catch (_) {}
  }
  if (typeof content.data === 'number' && content.data >= 0) {
    return `/proc/self/fd/${content.data}`;
  }
  if (typeof content.data === 'string' && fs.existsSync(content.data)) {
    return content.data;
  }
  return null;
}

function persistClipboardFile(content, payloadName, rawBuf) {
  const fileName = content.name || payloadName || `shared_file_${Date.now()}`;
  const existingPath = resolveExistingFilePath(content);
  if (existingPath) {
    return { fileName, filePath: existingPath };
  }
  const clipDir = '/tmp/xintent_clipboard';
  if (!fs.existsSync(clipDir)) {
    fs.mkdirSync(clipDir, { recursive: true });
  }
  const filePath = path.join(clipDir, fileName);
  fs.writeFileSync(filePath, rawBuf);
  return { fileName, filePath };
}

function buildSupportedTargetsList(atoms, clip) {
  const supported = [
    atoms.TARGETS,
    atoms.UTF8_STRING,
    atoms.STRING,
    atoms.TEXT,
    atoms['text/plain'],
    atoms['text/plain;charset=utf-8'],
  ];

  if (clip.fileUri) {
    if (atoms['text/uri-list']) supported.push(atoms['text/uri-list']);
    if (atoms['x-special/gnome-copied-files']) supported.push(atoms['x-special/gnome-copied-files']);
  }

  if (clip.type?.startsWith('image/')) {
    supported.push(
      atoms['image/png'],
      atoms['image/jpeg'],
      atoms['image/bmp'],
      atoms['image/webp'],
      atoms['image/gif']
    );
  }

  if (clip.type && atoms[clip.type] && !supported.includes(atoms[clip.type])) {
    supported.push(atoms[clip.type]);
  }
  return supported;
}

async function resolveBinarySelectionBuffer(clip, targetName) {
  let rawInputBuf = clip.rawBuf;
  if (!Buffer.isBuffer(rawInputBuf)) {
    rawInputBuf = extractRawBufferFromContent(clip);
  }
  const isImage = clip.type?.startsWith('image/');
  if (isImage && targetName.startsWith('image/') && clip.type !== targetName) {
    try {
      return await convertImageBuffer(rawInputBuf, targetName);
    } catch (_) {
      return rawInputBuf;
    }
  }
  return rawInputBuf;
}

function isLocalTempOrProcPath(p) {
  return typeof p === 'string' && (p.startsWith('/proc/') || p.startsWith('/tmp/') || p.startsWith('/dev/')) && fs.existsSync(p);
}

function resolveTextSelectionBuffer(clip) {
  const targetFilePath = clip.filePath || clip.data;
  if (isLocalTempOrProcPath(targetFilePath)) {
    return fs.readFileSync(targetFilePath);
  }
  const isText = clip.type?.startsWith('text/') || clip._dataType === 'text' || clip._dataType === 'fd-rights';
  if (isText) {
    return Buffer.from(clip.data || '', 'utf8');
  }
  if (clip.fileUri) {
    return Buffer.from(clip.fileUri, 'utf8');
  }
  if (clip.rawBuf) {
    return clip.rawBuf;
  }
  return Buffer.from(String(clip.data || ''), 'utf8');
}

module.exports = {
  convertImageBuffer,
  changePropertyChunked,
  buildSelectionNotifyBuffer,
  sendSelectionNotify,
  extractRawBufferFromContent,
  persistClipboardFile,
  buildSupportedTargetsList,
  resolveBinarySelectionBuffer,
  resolveTextSelectionBuffer,
};
