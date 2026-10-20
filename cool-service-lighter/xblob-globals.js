const crypto = require("crypto");
const fs = require("fs");
const xintent = require("../x11-promises/xintent");
const { Logger } = require("../server-tools");

const logger = new Logger({ module: "xblob-host" });

/**
 * Global map of active soft links mapping blob IDs to disk file paths.
 *
 * Structure:
 * {
 *   [blobId: string | number]: string  // e.g. '256' => '/tmp/shared_file.txt'
 * }
 */
const softLinks = {};

/**
 * Global registry map storing all in-memory XBlob objects managed by xblob-host.
 * Keyed by numeric blob ID, string blob ID, and hex string blob ID (e.g. 256, '256', '0x100').
 *
 * Structure of each XBlob object value in Map:
 * {
 *   openedFd?: number,               // Open OS file descriptor integer held by xblob-host
 *   data: string | Buffer | object | null, // Payload data (null when openedFd is present)
 *   type?: string,                   // MIME type, e.g. 'audio/wav', 'text/plain', 'application/json'
 *   xblobType?: string,              // XBlob category e.g. 'Blob', 'File', 'ReadableStream', 'MediaStream'
 *   _dataType?: string,              // Internal data representation: 'file-path', 'fd-rights', 'text', 'binary', 'base64', 'json'
 *   contentEncoding?: string,        // HTTP Content-Encoding: 'file-path', 'fd-rights', 'identity', 'base64'
 *   name?: string,                   // File name for file attachments e.g. 'speech.wav'
 *   size?: number,                   // Content length / file size in bytes
 *   url?: string,                    // Associated file URI e.g. 'file:///tmp/test.txt'
 *   storagePath?: string,            // Path to temporary storage-backed file if created
 *   headers?: Record<string, string> // Custom HTTP / XIntent headers
 * }
 */
const hostBlobs = new Map();

const parseBlobId = (str) => {
  if (str === null || str === undefined) return null;
  if (typeof str === 'number') return str;
  if (typeof str === 'string') {
    const s = str.trim();
    if (s.startsWith('0x') || s.startsWith('0X')) {
      const parsed = parseInt(s, 16);
      return isNaN(parsed) ? null : parsed;
    }
    const parsed = parseInt(s, 10);
    return isNaN(parsed) ? null : parsed;
  }
  return null;
};

const toHexBlobId = (id) => {
  if (id === null || id === undefined) return null;
  const num = typeof id === 'number' ? id : (typeof id === 'string' && (id.startsWith('0x') || id.startsWith('0X')) ? parseInt(id, 16) : Number(id));
  if (isNaN(num)) return id;
  return `0x${num.toString(16)}`;
};

let nextHostBlobSlot = 1;
const allocateHostBlobId = async (blobData = {}, initialHardLinker = null, X = null, lighterWin = 0) => {
  try {
    let typeAtom = 0;
    if (blobData && typeof blobData === 'object') {
      const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'text/plain');
      if (mimeType && X) {
        typeAtom = xintent.atoms[mimeType] || (await X.InternAtom(false, mimeType));
        if (typeAtom) xintent.atoms[mimeType] = typeAtom;
      }
    }

    if (X && lighterWin) {
      const cookie = crypto.randomBytes(4).readUInt32LE(0);
      const evBuf = xintent.buildClientMessageBuffer(xintent.routerWin, xintent.atoms.XBLOB_CREATE_V0, [
        lighterWin,
        cookie,
        typeAtom || 0,
        initialHardLinker || 0,
      ]);
      const responseEv = await X.seekResponsePacket(
        (ev) =>
          ev &&
          ev.type === 33 &&
          ev.message_type === xintent.atoms.XBLOB_CREATE_RESPONSE_V0 &&
          ev.data &&
          ((ev.data[2] >>> 0) === (cookie >>> 0)),
        5000
      ).SendEvent(xintent.routerWin, false, (xintent.x11 && xintent.x11.eventMask) ? xintent.x11.eventMask.NoEventMask : 0, evBuf);

      if (responseEv && responseEv.data && responseEv.data[1]) {
        return responseEv.data[1];
      }
    }
  } catch (err) {
    logger.warn(`allocateHostBlobId XBLOB_CREATE_V0 failed, falling back to local slot: ${err.message}`);
  }

  return nextHostBlobSlot++;
};

const xblobDestructor = async (message, X = null, lighterWin = 0) => {
  const blob = message.blob;
  const numBlob = parseBlobId(blob);
  const blobData = hostBlobs.get(blob) || (numBlob !== null ? hostBlobs.get(numBlob) : null);
  if (blobData && blobData.openedFd !== undefined) {
    try { fs.closeSync(blobData.openedFd); } catch (_) {}
  }
  delete softLinks[blob];
  hostBlobs.delete(blob);
  if (numBlob !== null) {
    hostBlobs.delete(numBlob);
  }
  if (X && lighterWin) {
    xintent.XBlobSoftUnlink(X, xintent.routerWin, lighterWin, blob);
  }
};

module.exports = {
  logger,
  softLinks,
  hostBlobs,
  parseBlobId,
  toHexBlobId,
  allocateHostBlobId,
  xblobDestructor
};
