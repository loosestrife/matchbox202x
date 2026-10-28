const fs = require('fs');

function extractRawBlobIdFromPath(pathParts) {
  const first = pathParts[0];
  if (first === 'blobs' || first === 'xblob') {
    const second = pathParts[1];
    if (second && second !== 'XBlobCreate' && second !== 'XBlobBroadcast') {
      return second;
    }
    return null;
  }
  return first || null;
}

function lookupHostBlob(hostBlobs, blobId, rawBlobId) {
  const direct = hostBlobs.get(blobId);
  if (direct) return direct;
  if (typeof blobId === 'number') {
    const byHexOrDec = hostBlobs.get(`0x${blobId.toString(16)}`) || hostBlobs.get(String(blobId));
    if (byHexOrDec) return byHexOrDec;
  }
  return typeof rawBlobId === 'string' ? hostBlobs.get(rawBlobId) : undefined;
}

function sendJsonBlobMetadata(res, blobData, hexBlobId) {
  const responseObj = Object.assign({}, blobData);
  if (responseObj.openedFd !== undefined && responseObj.openedFd !== null) {
    responseObj.data = `/proc/${process.pid}/fd/${responseObj.openedFd}`;
    responseObj._dataType = 'file-path';
    responseObj.contentEncoding = 'file-path';
  }
  const bodyStr = JSON.stringify({ status: 'ok', blobId: hexBlobId, blob: responseObj });
  res.writeHead(200, {
    'Content-Type': 'file-path',
    'Content-Encoding': 'file-path',
    'Content-Length': Buffer.byteLength(bodyStr, 'utf8'),
    'X-Blob-Id': hexBlobId,
    'Connection': 'close',
  });
  return res.end(bodyStr);
}

function resolveBlobFdPath(blobData) {
  if (blobData.openedFd !== undefined && blobData.openedFd !== null) {
    try { fs.lseekSync(blobData.openedFd, 0, 0); } catch (_) {}
    return `/proc/self/fd/${blobData.openedFd}`;
  }
  if (typeof blobData.data === 'number' && blobData.data >= 0) {
    try { fs.lseekSync(blobData.data, 0, 0); } catch (_) {}
    return `/proc/self/fd/${blobData.data}`;
  }
  if (typeof blobData.data === 'string') {
    const trimmed = blobData.data.trim();
    if (trimmed.startsWith('/proc/') || trimmed.startsWith('/dev/') || fs.existsSync(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function pipeFdPathResponse({ res, fdPath, blobData, blobId, hexBlobId, mimeType, isStream, logger }) {
  let statSize = 0;
  try {
    if (fs.existsSync(fdPath)) statSize = fs.statSync(fdPath).size;
  } catch (_) {}

  logger.info(`[xblob-host GET /blobs] Streaming fdPath='${fdPath}' (stat size=${statSize} bytes, stored size=${blobData.size}) for blobId=${blobId}`);

  const responseHeaders = {
    'Content-Type': mimeType,
    'Accept-Encoding': 'identity, base64, fd-rights, file-path',
    'X-XBlob-Type': blobData.xblobType || 'ReadableStream',
    'X-Blob-Id': hexBlobId,
  };
  const contentLen = blobData.size || statSize;
  if (!isStream && contentLen) {
    responseHeaders['Content-Length'] = contentLen;
  }
  res.writeHead(200, responseHeaders);

  let bytesPiped = 0;
  const readStream = fs.createReadStream(fdPath, { start: 0 });
  readStream.on('data', (chunk) => { bytesPiped += chunk.length; });
  readStream.on('end', () => {
    logger.info(`[xblob-host GET /blobs] Finished piping fdPath '${fdPath}' for blob 0x${blobId.toString(16)}: ${bytesPiped} total bytes written to HTTP response`);
  });
  readStream.on('error', (err) => {
    logger.error(`[xblob-host GET /blobs] Stream error on fdPath '${fdPath}' for blob 0x${blobId.toString(16)} after ${bytesPiped} bytes: ${err.message}`);
  });
  return readStream.pipe(res);
}

function serializeObjectBlobData(data) {
  if (Array.isArray(data.data)) return Buffer.from(data.data);
  if (Array.isArray(data)) return Buffer.from(data);
  return Buffer.from(JSON.stringify(data), 'utf8');
}

function serializeBlobDataToBuffer(blobData) {
  const { data } = blobData;
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === 'string') {
    return Buffer.from(data, blobData._dataType === 'base64' ? 'base64' : 'utf8');
  }
  if (data !== undefined && data !== null) {
    return typeof data === 'object' ? serializeObjectBlobData(data) : Buffer.from(String(data), 'utf8');
  }
  return Buffer.from(JSON.stringify(blobData), 'utf8');
}

function resolveBlobContentEncoding(blobData) {
  if (blobData.contentEncoding) return blobData.contentEncoding;
  const allowed = ['fd-rights', 'file-path', 'base64'];
  return allowed.includes(blobData._dataType) ? blobData._dataType : null;
}

function serveFoundBlob(req, res, { blobData, blobId, hexBlobId, url, logger }) {
  const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'application/octet-stream');
  const isStream = blobData.xblobType === 'ReadableStream' || blobData.xblobType === 'MediaStream' || req.headers['x-xblob-type'] === 'ReadableStream';

  logger.info(`[xblob-host GET /blobs] blobId=${blobId} (${hexBlobId}) stored state: size=${blobData.size}, openedFd=${blobData.openedFd}, _dataType=${blobData._dataType}, contentEncoding=${blobData.contentEncoding}, type=${mimeType}, dataIsBuffer=${Buffer.isBuffer(blobData.data)}, dataType=${typeof blobData.data}`);

  const wantsJson = req.headers['accept']?.includes('application/json') || url.pathname.includes('XBlobRead');
  if (wantsJson) {
    return sendJsonBlobMetadata(res, blobData, hexBlobId);
  }

  const fdPath = resolveBlobFdPath(blobData);
  if (fdPath) {
    return pipeFdPathResponse({ res, fdPath, blobData, blobId, hexBlobId, mimeType, isStream, logger });
  }

  const bodyBuf = serializeBlobDataToBuffer(blobData);
  const responseHeaders = {
    'Content-Type': mimeType,
    'Content-Length': bodyBuf.length,
    'Accept-Encoding': 'identity, base64, fd-rights, file-path',
    'X-Blob-Id': hexBlobId,
    'X-XBlob-Type': blobData.xblobType || 'Blob',
  };
  const contentEnc = resolveBlobContentEncoding(blobData);
  if (contentEnc) responseHeaders['Content-Encoding'] = contentEnc;

  res.writeHead(200, responseHeaders);
  return res.end(bodyBuf);
}

const handleGet = async (req, res, { url, pathParts, hostBlobs, parseBlobId, toHexBlobId, logger, os }) => {
  if (url.pathname === '/' || url.pathname === '/ping' || url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', host: os.hostname() }));
  }

  const rawBlobId = extractRawBlobIdFromPath(pathParts);
  const blobId = parseBlobId(rawBlobId);
  if (!blobId || url.pathname.endsWith('/broadcast')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'error', message: 'Not found' }));
  }

  try {
    const userAgent = req.headers['user-agent'] || 'unknown';
    logger.info(`[xblob-host GET /blobs] requested blobId=${blobId} (hex: ${toHexBlobId(blobId)}) from User-Agent "${userAgent}", found in hostBlobs: ${hostBlobs.has(blobId)}, total keys: ${hostBlobs.size}`);
    const blobData = lookupHostBlob(hostBlobs, blobId, rawBlobId);
    if (!blobData) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', message: 'Blob not found' }));
    }
    return serveFoundBlob(req, res, { blobData, blobId, hexBlobId: toHexBlobId(blobId), url, logger });
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'error', message: err.message }));
  }
};

module.exports = { handleGet };
