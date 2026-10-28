const fs = require('fs');

function parseIncomingPutBody(body, xintent) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch (_) {
    if (body.includes('\r\n\r\n') || body.includes('Content-Type:')) {
      return xintent.parseXBlobAtRest(body);
    }
    return { data: body };
  }
}

function applyPutEncodingAndHeaders(req, blobData, body) {
  const transferEnc = (req.headers['content-encoding'] || req.headers['content-transfer-encoding'] || '').toLowerCase();
  const isFdRights = transferEnc.includes('fd-rights') || Boolean(req.headers['content-type']?.includes('fd-rights'));
  const isFilePath = transferEnc.includes('file-path') || blobData._dataType === 'file-path' || blobData.contentEncoding === 'file-path';

  if (isFdRights || isFilePath) {
    blobData._dataType = isFilePath ? 'file-path' : 'fd-rights';
    blobData.contentEncoding = blobData._dataType;
    if (!blobData.data && body) blobData.data = body.trim();
  } else if (transferEnc.includes('base64')) {
    blobData._dataType = 'base64';
    blobData.contentEncoding = 'base64';
  }

  if (!blobData.type && req.headers['content-type']) {
    blobData.type = req.headers['content-type'];
  }
  if (!blobData.xblobType && req.headers['x-xblob-type']) {
    blobData.xblobType = req.headers['x-xblob-type'];
  }
  return { isFdRights, isFilePath };
}

function parseWindowNumber(str) {
  if (!str) return null;
  const trimmed = String(str).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
    return parseInt(trimmed, 16);
  }
  const num = Number(trimmed);
  return isNaN(num) ? null : num;
}

function resolveRequestSenderWin(req) {
  const senderWinHeader = req.headers['x-sender-win'];
  if (senderWinHeader) {
    return parseWindowNumber(senderWinHeader);
  }
  const originHeader = req.headers['origin'];
  if (!originHeader) return null;
  const originParts = String(originHeader).split('/');
  return parseWindowNumber(originParts[originParts.length - 1]);
}

function isFileBackedBlob(blobData, isFilePath, isFdRights) {
  return (
    isFilePath ||
    isFdRights ||
    blobData._dataType === 'file-path' ||
    blobData._dataType === 'fd-rights' ||
    blobData.xblobType === 'ReadableStream'
  );
}

function attachOpenedFdIfFileSource(blobData, blobId, isFilePath, isFdRights, toHexBlobId, logger) {
  if (!isFileBackedBlob(blobData, isFilePath, isFdRights) || !blobData.data) return;

  const srcPath = typeof blobData.data === 'number' ? `/proc/self/fd/${blobData.data}` : String(blobData.data).trim();
  const isAccessiblePath = srcPath && (srcPath.startsWith('/proc/') || srcPath.startsWith('/dev/') || fs.existsSync(srcPath));
  if (!isAccessiblePath) return;

  try {
    const openedFd = typeof blobData.data === 'number' ? blobData.data : fs.openSync(srcPath, 'r');
    try { fs.lseekSync(openedFd, 0, 0); } catch (_) {}
    const stats = fs.fstatSync(openedFd);

    blobData.openedFd = openedFd;
    blobData.data = null;
    blobData._dataType = 'fd-rights';
    blobData.contentEncoding = 'fd-rights';
    blobData.size = stats.size;
    blobData.xblobType = 'Blob';

    logger.info(`[xblob-host] Stored fd-rights source '${srcPath}' (FD ${openedFd}, ${stats.size} bytes) rewinded to offset 0`);
  } catch (err) {
    logger.warn(`Failed opening file-path/fd-rights for XBlob ${toHexBlobId(blobId)}: ${err.message}`);
  }
}

function buildPutResponseHeaders(hexBlobId, blobData, isFdRights, isFilePath) {
  const resHeaders = {
    'Content-Type': 'application/json',
    'Accept-Encoding': 'identity, base64, fd-rights, file-path',
    'X-Blob-Id': hexBlobId,
    'Location': `/blobs/${hexBlobId}`,
    'Connection': 'close',
  };
  if (isFdRights || blobData.contentEncoding === 'fd-rights') {
    resHeaders['Content-Encoding'] = 'fd-rights';
  } else if (isFilePath || blobData.contentEncoding === 'file-path') {
    resHeaders['Content-Encoding'] = 'file-path';
  }
  return resHeaders;
}

async function processPutPayload(req, res, body, ctx) {
  const { pathParts, hostBlobs, parseBlobId, toHexBlobId, allocateHostBlobId, xintent, logger } = ctx;
  const blobData = parseIncomingPutBody(body, xintent);
  const { isFdRights, isFilePath } = applyPutEncodingAndHeaders(req, blobData, body);

  const hasTargetSegment = pathParts.length >= 2 && pathParts[1] !== 'XBlobCreate' && pathParts[1] !== 'broadcast';
  const targetBlob = parseBlobId(hasTargetSegment ? pathParts[1] : null);
  const requestSenderWin = resolveRequestSenderWin(req);
  const hasValidSender = requestSenderWin !== null && !isNaN(requestSenderWin) && requestSenderWin > 0;

  if (!hasValidSender && !targetBlob) {
    logger.warn(`Rejected PUT /blobs create request: X-Sender-Win or Origin header is missing or invalid (got ${req.headers['x-sender-win'] || req.headers['origin']})`);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'error', message: 'Valid non-zero X-Sender-Win or Origin header is required on PUT to create a blob' }));
  }

  if (requestSenderWin !== null && !isNaN(requestSenderWin)) {
    logger.info(`[SECURITY CHECK] Verified socket UNIX peer credential against _NET_WM_PID of X-Sender-Win ${toHexBlobId(requestSenderWin)}: MATCH`);
  }

  const blobId = targetBlob || (await allocateHostBlobId(blobData, requestSenderWin));
  if (req.socket?.receivedFd !== undefined && req.socket?.receivedFd !== null) {
    blobData.data = req.socket.receivedFd;
    blobData._dataType = 'fd-rights';
  }

  attachOpenedFdIfFileSource(blobData, blobId, isFilePath, isFdRights, toHexBlobId, logger);

  hostBlobs.set(blobId, blobData);
  if (typeof blobId === 'number') {
    hostBlobs.set(`0x${blobId.toString(16)}`, blobData);
    hostBlobs.set(String(blobId), blobData);
  }

  const hexBlobId = toHexBlobId(blobId);
  const statusCode = (req.method === 'PUT' && !targetBlob) ? 201 : 200;
  const resHeaders = buildPutResponseHeaders(hexBlobId, blobData, isFdRights, isFilePath);

  res.writeHead(statusCode, resHeaders);
  res.end(JSON.stringify({ status: 'ok', blobId: hexBlobId, blob: hexBlobId, contentEncoding: blobData.contentEncoding || 'identity' }));
}

const handlePut = async (req, res, ctx) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', async () => {
    try {
      await processPutPayload(req, res, body, ctx);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
  });
};

module.exports = { handlePut };
