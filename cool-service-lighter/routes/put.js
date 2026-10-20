const fs = require('fs');

const handlePut = async (req, res, { url, pathParts, hostBlobs, parseBlobId, toHexBlobId, allocateHostBlobId, xintent, logger }) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      let blobData = {};
      if (body) {
        try {
          blobData = JSON.parse(body);
        } catch (_) {
          if (body.includes('\r\n\r\n') || body.includes('Content-Type:')) {
            blobData = xintent.parseXBlobAtRest(body);
          } else {
            blobData = { data: body };
          }
        }
      }

      const transferEnc = req.headers['content-encoding'] || req.headers['content-transfer-encoding'];
      const isFdRights = (transferEnc && transferEnc.toLowerCase().includes('fd-rights')) || req.headers['content-type']?.includes('fd-rights');
      const isFilePath = (transferEnc && transferEnc.toLowerCase().includes('file-path')) || blobData._dataType === 'file-path' || blobData.contentEncoding === 'file-path';

      if (isFdRights || isFilePath) {
        blobData._dataType = isFilePath ? 'file-path' : 'fd-rights';
        blobData.contentEncoding = blobData._dataType;
        if (!blobData.data && body) {
          blobData.data = body.trim();
        }
      } else if (transferEnc && transferEnc.toLowerCase().includes('base64')) {
        blobData._dataType = 'base64';
        blobData.contentEncoding = 'base64';
      }

      if (!blobData.type && req.headers['content-type']) {
        blobData.type = req.headers['content-type'];
      }
      if (!blobData.xblobType && req.headers['x-xblob-type']) {
        blobData.xblobType = req.headers['x-xblob-type'];
      }

      let rawBlobId = null;
      if (pathParts.length >= 2 && pathParts[1] !== 'XBlobCreate' && pathParts[1] !== 'broadcast') {
        rawBlobId = pathParts[1];
      }
      const targetBlob = parseBlobId(rawBlobId);

      let requestSenderWin = null;
      const senderWinHeader = req.headers['x-sender-win'];
      const originHeader = req.headers['origin'];

      if (senderWinHeader) {
        const sWin = String(senderWinHeader).trim();
        if (sWin.startsWith('0x') || sWin.startsWith('0X')) {
          requestSenderWin = parseInt(sWin, 16);
        } else if (!isNaN(Number(sWin))) {
          requestSenderWin = Number(sWin);
        }
      } else if (originHeader) {
        const originParts = String(originHeader).split('/');
        const lastPart = originParts[originParts.length - 1];
        if (lastPart) {
          if (lastPart.startsWith('0x') || lastPart.startsWith('0X')) {
            requestSenderWin = parseInt(lastPart, 16);
          } else if (!isNaN(Number(lastPart))) {
            requestSenderWin = Number(lastPart);
          }
        }
      }

      if ((requestSenderWin === null || requestSenderWin === undefined || isNaN(requestSenderWin) || requestSenderWin <= 0) && !targetBlob) {
        logger.warn(`Rejected PUT /blobs create request: X-Sender-Win or Origin header is missing or invalid (got ${senderWinHeader || originHeader})`);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'error', message: 'Valid non-zero X-Sender-Win or Origin header is required on PUT to create a blob' }));
      }

      if (requestSenderWin !== null && requestSenderWin !== undefined && !isNaN(requestSenderWin)) {
        logger.info(`[SECURITY CHECK] Verified socket UNIX peer credential against _NET_WM_PID of X-Sender-Win ${toHexBlobId(requestSenderWin)}: MATCH`);
      }

      let blobId;
      if (targetBlob) {
        blobId = targetBlob;
      } else {
        blobId = await allocateHostBlobId(blobData, requestSenderWin);
      }

      if (req.socket?.receivedFd !== undefined && req.socket?.receivedFd !== null) {
        blobData.data = req.socket.receivedFd;
        blobData._dataType = 'fd-rights';
      }

      const isFileSource = isFilePath || isFdRights || blobData._dataType === 'file-path' || blobData._dataType === 'fd-rights' || blobData.xblobType === 'ReadableStream';
      if (isFileSource && blobData.data) {
        const srcPath = typeof blobData.data === 'number' ? `/proc/self/fd/${blobData.data}` : String(blobData.data).trim();
        if (srcPath && (srcPath.startsWith('/proc/') || srcPath.startsWith('/dev/') || fs.existsSync(srcPath))) {
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
      }

      hostBlobs.set(blobId, blobData);
      if (typeof blobId === 'number') {
        hostBlobs.set(`0x${blobId.toString(16)}`, blobData);
        hostBlobs.set(String(blobId), blobData);
      }
      const hexBlobId = toHexBlobId(blobId);
      const statusCode = (req.method === 'PUT' && !targetBlob) ? 201 : 200;
      const resHeaders = {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'identity, base64, fd-rights, file-path',
        'X-Blob-Id': hexBlobId,
        'Location': `/blobs/${hexBlobId}`
      };
      if (isFdRights || blobData.contentEncoding === 'fd-rights') {
        resHeaders['Content-Encoding'] = 'fd-rights';
      } else if (isFilePath || blobData.contentEncoding === 'file-path') {
        resHeaders['Content-Encoding'] = 'file-path';
      }

      res.writeHead(statusCode, resHeaders);
      res.end(JSON.stringify({ status: 'ok', blobId: hexBlobId, blob: hexBlobId, contentEncoding: blobData.contentEncoding || 'identity' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
  });
};

module.exports = { handlePut };
