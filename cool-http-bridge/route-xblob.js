const xintent = require('../x11-promises/xintent');
const { Logger } = require('../server-tools');

const logger = new Logger({ module: 'route-xblob' });

module.exports = ({ X, clientWin }) => {
  const routerWin = () => xintent.routerWin;

  const routeXBlobCreate = async (req, res) => {
    let blobData = req.body || {};
    if (typeof req.body === 'string' && (req.body.includes('Content-Type:') || req.body.includes('X-XBlob-Type:'))) {
      blobData = xintent.parseXBlobAtRest(req.body);
    } else if (req.headers['content-type'] && !req.headers['content-type'].includes('application/json')) {
      const mimeType = req.headers['content-type'];
      const transferEnc = req.headers['content-encoding'] || req.headers['content-transfer-encoding'];
      const isBase64 = transferEnc && transferEnc.toLowerCase().includes('base64');
      const bodyStr = typeof req.body === 'string' ? req.body : (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body));
      blobData = {
        xblobType: req.headers['x-xblob-type'] || 'Blob',
        type: mimeType,
        size: req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : Buffer.byteLength(bodyStr, 'utf8'),
        name: req.headers['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1] || null,
        _dataType: isBase64 ? 'base64' : 'text',
        data: bodyStr,
      };
    }
    logger.info(`POST /xblob/XBlobCreate`, blobData);
    const blobId = await xintent.XBlobCreate(X, routerWin(), clientWin, blobData);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId, blob: blobId });
  };

  const routeXBlobRead = async (req, res) => {
    const targetBlob = Number(req.body?.blobId || req.body?.blob || req.params?.blobId);
    logger.info(`GET/POST /xblob/XBlobRead blob=${targetBlob}`);
    try {
      const blobData = await xintent.XBlobRead(X, routerWin(), targetBlob);
      res.setHeader('Matchbox-Bridge', '1.0');
      res.setHeader('X-Blob-Id', targetBlob);

      const acceptHeader = req.headers['accept'] || '';
      const isRawHttpRequested = req.method === 'GET' || acceptHeader.includes('*/*') || acceptHeader.includes('audio/') || acceptHeader.includes('image/') || acceptHeader.includes('text/') || acceptHeader.includes('application/octet-stream') || req.query?.format === 'http';

      if (isRawHttpRequested && !req.body?.json) {
        const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'application/octet-stream');
        const dataType = blobData._dataType || (mimeType.includes('application/json') ? 'json' : 'binary');

        let bodyPayload = blobData.data !== undefined ? blobData.data : blobData;
        let bodyBuf;
        if (Buffer.isBuffer(bodyPayload)) {
          bodyBuf = bodyPayload;
        } else if (typeof bodyPayload === 'object') {
          bodyBuf = Buffer.from(JSON.stringify(bodyPayload), 'utf8');
        } else {
          bodyBuf = Buffer.from(String(bodyPayload), 'utf8');
        }

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', blobData.size !== undefined ? blobData.size : bodyBuf.length);
        if (dataType === 'base64') {
          res.setHeader('Content-Encoding', 'base64');
        }
        if (blobData.name) {
          res.setHeader('Content-Disposition', `attachment; filename="${blobData.name}"`);
        } else if (!mimeType.includes('application/json')) {
          res.setHeader('Content-Disposition', 'inline');
        }
        res.setHeader('X-XBlob-Type', blobData.xblobType || 'Blob');

        return res.status(200).send(bodyBuf);
      }

      res.status(200).json({ status: 'ok', blobId: targetBlob, blob: blobData });
    } catch (err) {
      res.status(404).json({ status: 'error', message: err.message });
    }
  };

  const routeXBlobTransfer = async (req, res) => {
    const { blobId, blob, grantee } = req.body || {};
    const targetBlob = Number(blobId || blob);
    const granteeWin = Number(grantee || routerWin());
    logger.info(`POST /xblob/XBlobTransfer blob=${targetBlob} grantee=${granteeWin}`);
    await xintent.XBlobTransfer(X, routerWin(), clientWin, targetBlob, granteeWin);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId: targetBlob });
  };

  const routeXBlobGrant = async (req, res) => {
    const { blobId, blob, grantee } = req.body || {};
    const targetBlob = Number(blobId || blob);
    const granteeWin = Number(grantee || routerWin());
    logger.info(`POST /xblob/XBlobGrant blob=${targetBlob} grantee=${granteeWin}`);
    await xintent.XBlobGrant(X, routerWin(), clientWin, targetBlob, granteeWin);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId: targetBlob });
  };

  const routeXBlobUnlink = async (req, res) => {
    const { blobId, blob } = req.body || {};
    const targetBlob = Number(blobId || blob);
    logger.info(`POST /xblob/XBlobUnlink blob=${targetBlob}`);
    await xintent.XBlobUnlink(X, routerWin(), clientWin, targetBlob);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId: targetBlob });
  };

  const routeXBlobBroadcast = async (req, res) => {
    const { blobId, blob, host, version } = req.body || {};
    const targetBlob = Number(blobId || blob);
    logger.info(`POST /xblob/XBlobBroadcast blob=${targetBlob} version=${version}`);
    await xintent.XBlobBroadcast(X, routerWin(), clientWin, targetBlob, host, version);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.status(200).json({ status: 'ok', blobId: targetBlob });
  };

  return {
    routeXBlobCreate,
    routeXBlobRead,
    routeXBlobTransfer,
    routeXBlobGrant,
    routeXBlobUnlink,
    routeXBlobBroadcast,
  };
};
