const fs = require('fs');
const path = require('path');

const handleGet = async (req, res, { url, pathParts, hostBlobs, parseBlobId, toHexBlobId, logger, os }) => {
  if (url.pathname === '/' || url.pathname === '/ping' || url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', host: os.hostname() }));
  }

  let rawBlobId = null;
  if (pathParts[0] === 'blobs' || pathParts[0] === 'xblob') {
    if (pathParts[1] && pathParts[1] !== 'XBlobCreate' && pathParts[1] !== 'XBlobBroadcast') {
      rawBlobId = pathParts[1];
    }
  } else if (pathParts[0]) {
    rawBlobId = pathParts[0];
  }

  const blobId = parseBlobId(rawBlobId);
  if (blobId && !url.pathname.endsWith('/broadcast')) {
    try {
      const userAgent = req.headers['user-agent'] || 'unknown';
      logger.info(`[xblob-host GET /blobs] requested blobId=${blobId} (hex: ${toHexBlobId(blobId)}) from User-Agent "${userAgent}", found in hostBlobs: ${hostBlobs.has(blobId)}, total keys: ${hostBlobs.size}`);
      let blobData = hostBlobs.get(blobId);
      if (!blobData && typeof blobId === 'number') {
        blobData = hostBlobs.get(`0x${blobId.toString(16)}`) || hostBlobs.get(String(blobId));
      }
      if (!blobData && typeof rawBlobId === 'string') {
        blobData = hostBlobs.get(rawBlobId);
      }

      if (!blobData) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: 'Blob not found' }));
      }
      const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'application/octet-stream');
      const isStream = blobData.xblobType === 'ReadableStream' || blobData.xblobType === 'MediaStream' || req.headers['x-xblob-type'] === 'ReadableStream';
      const hexBlobId = toHexBlobId(blobId);

      logger.info(`[xblob-host GET /blobs] blobId=${blobId} (${hexBlobId}) stored state: size=${blobData.size}, openedFd=${blobData.openedFd}, _dataType=${blobData._dataType}, contentEncoding=${blobData.contentEncoding}, type=${mimeType}, dataIsBuffer=${Buffer.isBuffer(blobData.data)}, dataType=${typeof blobData.data}`);

      const wantsJson = req.headers['accept']?.includes('application/json') || url.pathname.includes('XBlobRead');
      if (wantsJson) {
        const responseObj = Object.assign({}, blobData);
        if (responseObj.openedFd !== undefined && responseObj.openedFd !== null) {
          responseObj.data = `/proc/${process.pid}/fd/${responseObj.openedFd}`;
          responseObj._dataType = 'file-path';
          responseObj.contentEncoding = 'file-path';
        }
        res.writeHead(200, {
          'Content-Type': 'file-path',
          'Content-Encoding': 'file-path',
          'X-Blob-Id': hexBlobId
        });
        return res.end(JSON.stringify({ status: 'ok', blobId: hexBlobId, blob: responseObj }));
      }

      // Handle streaming file descriptor or disk path
      let fdPath = null;
      if (blobData.openedFd !== undefined && blobData.openedFd !== null) {
        try { fs.lseekSync(blobData.openedFd, 0, 0); } catch (_) {}
        fdPath = `/proc/self/fd/${blobData.openedFd}`;
      } else if (typeof blobData.data === 'number' && blobData.data >= 0) {
        try { fs.lseekSync(blobData.data, 0, 0); } catch (_) {}
        fdPath = `/proc/self/fd/${blobData.data}`;
      } else if (typeof blobData.data === 'string') {
        const trimmed = blobData.data.trim();
        if (trimmed.startsWith('/proc/') || trimmed.startsWith('/dev/') || fs.existsSync(trimmed)) {
          fdPath = trimmed;
        }
      }

      if (fdPath) {
        let statSize = 0;
        try {
          if (fs.existsSync(fdPath)) {
            statSize = fs.statSync(fdPath).size;
          }
        } catch (_) {}

        logger.info(`[xblob-host GET /blobs] Streaming fdPath='${fdPath}' (stat size=${statSize} bytes, stored size=${blobData.size}) for blobId=${blobId}`);

        const responseHeaders = {
          'Content-Type': mimeType,
          'Accept-Encoding': 'identity, base64, fd-rights, file-path',
          'X-XBlob-Type': blobData.xblobType || 'ReadableStream',
          'X-Blob-Id': hexBlobId
        };
        if (!isStream && (blobData.size || statSize)) {
          responseHeaders['Content-Length'] = blobData.size || statSize;
        }
        res.writeHead(200, responseHeaders);

        let bytesPiped = 0;
        const readStream = fs.createReadStream(fdPath, { start: 0 });
        readStream.on('data', (chunk) => {
          bytesPiped += chunk.length;
        });
        readStream.on('end', () => {
          logger.info(`[xblob-host GET /blobs] Finished piping fdPath '${fdPath}' for blob 0x${blobId.toString(16)}: ${bytesPiped} total bytes written to HTTP response`);
        });
        readStream.on('error', (err) => {
          logger.error(`[xblob-host GET /blobs] Stream error on fdPath '${fdPath}' for blob 0x${blobId.toString(16)} after ${bytesPiped} bytes: ${err.message}`);
        });

        return readStream.pipe(res);
      }

      let bodyBuf;
      if (Buffer.isBuffer(blobData.data)) {
        bodyBuf = blobData.data;
      } else if (typeof blobData.data === 'string') {
        bodyBuf = Buffer.from(blobData.data, blobData._dataType === 'base64' ? 'base64' : 'utf8');
      } else if (blobData.data !== undefined && blobData.data !== null && typeof blobData.data === 'object') {
        if (Array.isArray(blobData.data.data)) {
          bodyBuf = Buffer.from(blobData.data.data);
        } else if (Array.isArray(blobData.data)) {
          bodyBuf = Buffer.from(blobData.data);
        } else {
          bodyBuf = Buffer.from(JSON.stringify(blobData.data), 'utf8');
        }
      } else if (blobData.data !== undefined && blobData.data !== null) {
        bodyBuf = Buffer.from(String(blobData.data), 'utf8');
      } else {
        bodyBuf = Buffer.from(JSON.stringify(blobData), 'utf8');
      }

      const responseHeaders = {
        'Content-Type': mimeType,
        'Content-Length': bodyBuf.length,
        'Accept-Encoding': 'identity, base64, fd-rights, file-path',
        'X-Blob-Id': hexBlobId,
        'X-XBlob-Type': blobData.xblobType || 'Blob'
      };
      const contentEnc = blobData.contentEncoding || (blobData._dataType === 'fd-rights' ? 'fd-rights' : (blobData._dataType === 'file-path' ? 'file-path' : (blobData._dataType === 'base64' ? 'base64' : null)));
      if (contentEnc) {
        responseHeaders['Content-Encoding'] = contentEnc;
      }
      res.writeHead(200, responseHeaders);
      return res.end(bodyBuf);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'error', message: 'Not found' }));
};

module.exports = { handleGet };
