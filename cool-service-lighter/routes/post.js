const handlePost = async (req, res, { url, pathParts, parseBlobId, toHexBlobId, xintent, X, lighterWin, handlePut }) => {
  // Handle POST /blobs/:blobId/broadcast, POST /xblob/:blobId/broadcast, POST /xblob/XBlobBroadcast
  if (url.pathname.endsWith('/broadcast') || url.pathname.includes('XBlobBroadcast')) {
    let rawBlobId = null;
    if (url.pathname.endsWith('/broadcast')) {
      if (pathParts.length >= 2) {
        rawBlobId = pathParts[pathParts.length - 2];
      }
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        let payload = {};
        if (body) {
          try { payload = JSON.parse(body); } catch (_) {}
        }
        const targetBlob = parseBlobId(rawBlobId || payload.blobId || payload.blob || url.searchParams.get('blobId') || url.searchParams.get('blob'));
        if (!targetBlob) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ status: 'error', message: 'Invalid or missing blob ID' }));
        }
        const host = payload.host || url.searchParams.get('host') || null;
        const version = payload.version || url.searchParams.get('version') || null;

        const hexBlobId = toHexBlobId(targetBlob);
        if (X && lighterWin) {
          await xintent.XBlobBroadcast(X, xintent.routerWin, lighterWin, targetBlob, host, version);
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Accept-Encoding': 'identity, base64, fd-rights, file-path',
          'X-Blob-Id': hexBlobId
        });
        res.end(JSON.stringify({ status: 'ok', blobId: hexBlobId, blob: hexBlobId }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: err.message }));
      }
    });
    return;
  }

  // Fallback creation POST delegates to handlePut
  return handlePut(req, res);
};

module.exports = { handlePost };
