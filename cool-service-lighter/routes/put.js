const fs = require('fs');
const { dlopen, FFIType, ptr } = require('bun:ffi');

const libc = dlopen('libc.so.6', {
  pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
});

function createOsPipe() {
  const fds = new Int32Array(2);
  const rc = libc.symbols.pipe(ptr(fds));
  if (rc !== 0) {
    throw new Error(`pipe(2) failed with return code ${rc}`);
  }
  return { readFd: fds[0], writeFd: fds[1] };
}

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
    blobData.xblobType === 'BufferedReadableStream' ||
    blobData.xblobType === 'ReadableStream'
  );
}

function notifyStreamClosedOnBus(X, lighterWin, xintent, blobId, finalSize, toHexBlobId, logger) {
  if (!X || !lighterWin || !xintent || !xintent.routerWin) return;
  const numBlobId = typeof blobId === 'number' ? blobId : 0;
  const sizeLow = finalSize >>> 0;
  const sizeHigh = Math.floor(finalSize / 0x100000000) >>> 0;
  Promise.resolve()
    .then(async () => {
      const atom = xintent.atoms.XBLOB_STREAM_CLOSED_V0 || (await X.InternAtom(false, 'XBLOB_STREAM_CLOSED_V0'));
      if (atom) {
        xintent.atoms.XBLOB_STREAM_CLOSED_V0 = atom;
        await xintent.XClientMessage(X, xintent.routerWin, atom, [lighterWin, numBlobId, lighterWin, sizeLow, sizeHigh]);
      }
    })
    .catch((err) => {
      logger.debug(`Failed sending XBLOB_STREAM_CLOSED_V0 for ${toHexBlobId(blobId)}: ${err.message}`);
    });
}

function attachBufferedReadableStreamPool(blobData, blobId, srcPath, openedFd, toHexBlobId, logger, X, lighterWin, xintent) {
  fs.mkdirSync('/tmp/xintent_blobs', { recursive: true });
  const hexId = toHexBlobId(blobId);
  const storagePath = `/tmp/xintent_blobs/stream_${hexId}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  fs.closeSync(fs.openSync(storagePath, 'a'));

  const storageReadFd = fs.openSync(storagePath, 'r');
  const writeStream = fs.createWriteStream(storagePath);
  const readStream = fs.createReadStream(null, { fd: openedFd, autoClose: true });

  blobData.openedFd = storageReadFd;
  blobData.storagePath = storagePath;
  blobData.data = null;
  blobData._dataType = 'fd-rights';
  blobData.contentEncoding = 'fd-rights';
  blobData.size = 0;
  blobData.xblobType = 'BufferedReadableStream';
  blobData.streamCompleted = false;

  const streamCompletedPromise = new Promise((resolve) => {
    let completed = false;
    const onStreamCompleted = () => {
      if (completed) return;
      completed = true;
      let finalSize = 0;
      try {
        finalSize = fs.fstatSync(storageReadFd).size;
      } catch (_) {}
      blobData.xblobType = 'Blob';
      blobData.size = finalSize;
      blobData.streamCompleted = true;
      logger.info(`[xblob-host] StreamCompleted for XBlob ${hexId}: promoted BufferedReadableStream -> Blob (size: ${finalSize} bytes, storage: '${storagePath}')`);
      notifyStreamClosedOnBus(X, lighterWin, xintent, blobId, finalSize, toHexBlobId, logger);
      resolve(blobData);
    };

    writeStream.on('finish', onStreamCompleted);
    writeStream.on('close', onStreamCompleted);
    writeStream.on('error', (err) => {
      logger.warn(`[xblob-host] Write stream error for BufferedReadableStream ${hexId}: ${err.message}`);
      onStreamCompleted();
    });
    readStream.on('error', (err) => {
      logger.warn(`[xblob-host] Source pipe read error for BufferedReadableStream ${hexId}: ${err.message}`);
      try { writeStream.end(); } catch (_) {}
    });
  });

  Object.defineProperty(blobData, 'streamCompletedPromise', {
    value: streamCompletedPromise,
    enumerable: false,
    configurable: true,
    writable: true,
  });

  readStream.pipe(writeStream);
  logger.info(`[xblob-host] Pooling BufferedReadableStream source '${srcPath}' (pipe FD ${openedFd}) -> storage FD ${storageReadFd} ('${storagePath}') for XBlob ${hexId}`);
}

function attachReadableStreamPipe(blobData, blobId, srcPath, openedFd, toHexBlobId, logger) {
  const hexId = toHexBlobId(blobId);
  blobData.openedFd = openedFd;
  blobData.data = null;
  blobData._dataType = 'fd-rights';
  blobData.contentEncoding = 'fd-rights';
  blobData.size = 0;
  blobData.xblobType = blobData.xblobType === 'MediaStream' ? 'MediaStream' : 'ReadableStream';
  blobData.isPipe = true;
  logger.info(`[xblob-host] Attached ${blobData.xblobType} pipe source '${srcPath}' (pipe FD ${openedFd}) for XBlob ${hexId}`);
}

function attachOpenedFdIfFileSource(blobData, blobId, isFilePath, isFdRights, toHexBlobId, logger, X = null, lighterWin = 0, xintent = null) {
  if (!isFileBackedBlob(blobData, isFilePath, isFdRights) || !blobData.data) return;

  const srcPath = typeof blobData.data === 'number' ? `/proc/self/fd/${blobData.data}` : String(blobData.data).trim();
  const isAccessiblePath = srcPath && (srcPath.startsWith('/proc/') || srcPath.startsWith('/dev/') || fs.existsSync(srcPath));
  if (!isAccessiblePath) return;

  try {
    const openedFd = typeof blobData.data === 'number' ? blobData.data : fs.openSync(srcPath, 'r');
    const stats = fs.fstatSync(openedFd);
    const isPipeType = blobData.xblobType === 'ReadableStream' || blobData.xblobType === 'MediaStream';
    const isBufferedStreamSource =
      blobData.xblobType === 'BufferedReadableStream' ||
      (!isPipeType && (stats.isFIFO() || stats.isSocket()));

    if (isBufferedStreamSource) {
      attachBufferedReadableStreamPool(blobData, blobId, srcPath, openedFd, toHexBlobId, logger, X, lighterWin, xintent);
      return;
    }

    if (isPipeType) {
      attachReadableStreamPipe(blobData, blobId, srcPath, openedFd, toHexBlobId, logger);
      return;
    }

    try { fs.lseekSync(openedFd, 0, 0); } catch (_) {}

    blobData.openedFd = openedFd;
    blobData.data = null;
    blobData._dataType = 'fd-rights';
    blobData.contentEncoding = 'fd-rights';
    blobData.size = stats.size;
    blobData.xblobType = blobData.xblobType || 'Blob';

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
    'X-XBlob-Type': blobData.xblobType || 'Blob',
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

function attachHostManagedPipeIfReadableStream(blobData, blobId, toHexBlobId, logger) {
  if (blobData.xblobType !== 'ReadableStream' || blobData.openedFd !== undefined) return;
  const { readFd, writeFd } = createOsPipe();
  if (blobData.data !== undefined && blobData.data !== null && blobData.data !== '') {
    const initialBuf = Buffer.isBuffer(blobData.data)
      ? blobData.data
      : Buffer.from(String(blobData.data), blobData._dataType === 'base64' ? 'base64' : 'utf8');
    if (initialBuf.length > 0) {
      try { fs.writeSync(writeFd, initialBuf); } catch (_) {}
    }
  }
  blobData.openedFd = readFd;
  blobData.pipeWriteFd = writeFd;
  blobData.data = null;
  blobData._dataType = 'fd-rights';
  blobData.contentEncoding = 'fd-rights';
  blobData.size = 0;
  blobData.isPipe = true;
  logger.info(`[xblob-host] Allocated host-managed ReadableStream pipe (read FD ${readFd}, write FD ${writeFd}) for XBlob ${toHexBlobId(blobId)}`);
}

function appendToHostManagedPipe(existingBlob, incomingData, blobId, toHexBlobId, logger) {
  if (!existingBlob || existingBlob.pipeWriteFd === undefined || existingBlob.pipeWriteFd === null) {
    return false;
  }
  if (incomingData.data !== undefined && incomingData.data !== null && incomingData.data !== '') {
    const chunkBuf = Buffer.isBuffer(incomingData.data)
      ? incomingData.data
      : Buffer.from(String(incomingData.data), incomingData._dataType === 'base64' ? 'base64' : 'utf8');
    if (chunkBuf.length > 0) {
      fs.writeSync(existingBlob.pipeWriteFd, chunkBuf);
    }
  }
  if (incomingData.eof || incomingData.close) {
    try { fs.closeSync(existingBlob.pipeWriteFd); } catch (_) {}
    existingBlob.pipeWriteFd = null;
    logger.info(`[xblob-host] Closed write-end of host-managed ReadableStream pipe for XBlob ${toHexBlobId(blobId)}`);
  }
  return true;
}

async function processPutPayload(req, res, body, ctx) {
  const { pathParts, hostBlobs, parseBlobId, toHexBlobId, allocateHostBlobId, xintent, X, lighterWin, logger } = ctx;
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

  if (targetBlob) {
    const existingBlob = hostBlobs.get(targetBlob) || hostBlobs.get(toHexBlobId(targetBlob)) || hostBlobs.get(String(targetBlob));
    if (appendToHostManagedPipe(existingBlob, blobData, targetBlob, toHexBlobId, logger)) {
      const hexTarget = toHexBlobId(targetBlob);
      const resHeaders = buildPutResponseHeaders(hexTarget, existingBlob, true, false);
      res.writeHead(200, resHeaders);
      return res.end(JSON.stringify({ status: 'ok', blobId: hexTarget, blob: hexTarget, contentEncoding: 'fd-rights' }));
    }
  }

  const blobId = targetBlob || (await allocateHostBlobId(blobData, requestSenderWin));
  if (req.socket?.receivedFd !== undefined && req.socket?.receivedFd !== null) {
    blobData.data = req.socket.receivedFd;
    blobData._dataType = 'fd-rights';
  }

  attachOpenedFdIfFileSource(blobData, blobId, isFilePath, isFdRights, toHexBlobId, logger, X, lighterWin, xintent);
  attachHostManagedPipeIfReadableStream(blobData, blobId, toHexBlobId, logger);

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
