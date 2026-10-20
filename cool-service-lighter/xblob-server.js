const fs = require('fs');
const http = require('http');
const os = require('os');

const { logger, hostBlobs, parseBlobId, toHexBlobId, allocateHostBlobId } = require('./xblob-globals');
const { handleGet } = require('./routes/get');
const { handlePut } = require('./routes/put');
const { handlePost } = require('./routes/post');

const createXBlobSocketServer = (sockPath, xintent = null, X = null, lighterWin = 0) => {
  if (fs.existsSync(sockPath)) {
    try {
      fs.unlinkSync(sockPath);
    } catch (_) {}
  }

  try {
    require('x11/lib/fdpass');
  } catch (_) {}

  const server = http.createServer(async (req, res) => {
    try {
      if (req.socket?.receivedFd !== undefined && req.socket?.receivedFd !== null) {
        req.headers['content-encoding'] = 'fd-rights';
      }
      const url = new URL(req.url, 'http://localhost');
      const pathParts = url.pathname.split('/').filter(Boolean);

      const ctx = {
        url,
        pathParts,
        hostBlobs,
        parseBlobId,
        toHexBlobId,
        allocateHostBlobId: (blobData, initialHardLinker) => allocateHostBlobId(blobData, initialHardLinker, X, lighterWin),
        xintent,
        X,
        lighterWin,
        logger,
        os
      };

      if (req.method === 'GET') {
        return handleGet(req, res, ctx);
      }

      if (req.method === 'PUT') {
        return handlePut(req, res, ctx);
      }

      if (req.method === 'POST') {
        ctx.handlePut = () => handlePut(req, res, ctx);
        return handlePost(req, res, ctx);
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: 'Method not allowed' }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
  });

  server.listen(sockPath, () => {
    logger.info(`XBlob socket listening at ${sockPath}`);
  });

  server.on('error', (err) => {
    logger.error(`XBlob socket server error:`, err);
  });

  const cleanup = () => {
    if (fs.existsSync(sockPath)) {
      try {
        fs.unlinkSync(sockPath);
      } catch (_) {}
    }
  };

  return { server, cleanup };
};

module.exports = { createXBlobSocketServer };
