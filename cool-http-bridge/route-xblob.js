const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xintent = require('../x11-promises/xintent');
const { Logger } = require('../server-tools');

const logger = new Logger({ module: 'route-xblob' });

const toHexBlobId = (id) => {
  if (id === null || id === undefined) return null;
  const num = typeof id === 'number' ? id : (typeof id === 'string' && (id.startsWith('0x') || id.startsWith('0X')) ? parseInt(id, 16) : Number(id));
  if (isNaN(num)) return id;
  return `0x${num.toString(16)}`;
};

module.exports = ({ X, clientWin }) => {
  const routerWin = () => xintent.routerWin;

  const routeXBlobCreate = async (req, res) => {
    let blobData = req.body || {};
    if (typeof req.body === 'string' && (req.body.includes('Content-Type:') || req.body.includes('X-XBlob-Type:'))) {
      blobData = xintent.parseXBlobAtRest(req.body);
    } else if (req.headers['content-type'] && !req.headers['content-type'].includes('application/json')) {
      const mimeType = req.headers['content-type'];
      const transferEnc = req.headers['content-encoding'] || req.headers['content-transfer-encoding'];
      let dataType = 'text';
      let dataVal = req.body;
      if (transferEnc) {
        const lower = transferEnc.toLowerCase();
        if (lower.includes('fd-rights')) {
          dataType = 'fd-rights';
          dataVal = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
        } else if (lower.includes('base64')) {
          dataType = 'base64';
          dataVal = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
        }
      } else if (Buffer.isBuffer(req.body)) {
        const blobDir = '/tmp/xintent_blobs';
        if (!fs.existsSync(blobDir)) fs.mkdirSync(blobDir, { recursive: true });
        const fileName = req.headers['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1] || `blob_${Date.now()}`;
        const tempPath = path.join(blobDir, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${path.basename(fileName)}`);
        const fd = fs.openSync(tempPath, 'w+');
        fs.writeSync(fd, req.body);
        try { fs.unlinkSync(tempPath); } catch (_) {}

        dataType = 'fd-rights';
        dataVal = `/proc/${process.pid}/fd/${fd}`;
      } else {
        dataVal = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }
      blobData = {
        xblobType: req.headers['x-xblob-type'] || 'Blob',
        type: mimeType,
        size: req.headers['content-length'] ? parseInt(req.headers['content-length'], 10) : (Buffer.isBuffer(dataVal) ? dataVal.length : Buffer.byteLength(String(dataVal), 'utf8')),
        name: req.headers['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1] || null,
        _dataType: dataType,
        contentEncoding: dataType === 'fd-rights' ? 'fd-rights' : (dataType === 'base64' ? 'base64' : null),
        data: dataVal,
      };
    }

    const rawBlob = req.params?.blobId;
    let targetBlob = null;
    if (rawBlob) {
      targetBlob = typeof rawBlob === 'number' ? rawBlob : (typeof rawBlob === 'string' && (rawBlob.startsWith('0x') || rawBlob.startsWith('0X')) ? parseInt(rawBlob, 16) : Number(rawBlob));
    }

    let blobId;
    if (targetBlob) {
      await xintent.XBlobWrite(X, routerWin(), clientWin, targetBlob, blobData);
      blobId = targetBlob;
    } else {
      blobId = await xintent.XBlobCreate(X, routerWin(), clientWin, blobData);
    }

    const hexBlobId = toHexBlobId(blobId);
    const fileNameStr = blobData.name ? ` "${blobData.name}"` : '';
    const sizeStr = blobData.size ? `${blobData.size.toLocaleString()} bytes` : '0 bytes';
    logger.info(`Finished receiving XBlob upload${fileNameStr} -> created blob ${hexBlobId} (${blobData.type || 'unknown type'}, ${sizeStr})`);

    res.setHeader('Matchbox-Bridge', '1.0');
    res.setHeader('Accept-Encoding', 'identity, base64, fd-rights');
    res.setHeader('X-Blob-Id', hexBlobId);
    if (blobData._dataType === 'fd-rights' || blobData.contentEncoding === 'fd-rights') {
      res.setHeader('Content-Encoding', 'fd-rights');
    }
    const statusCode = req.method === 'PUT' && !targetBlob ? 201 : 200;
    res.status(statusCode).json({ status: 'ok', blobId: hexBlobId, blob: hexBlobId, contentEncoding: blobData.contentEncoding || 'identity' });
  };

  const routeXBlobRead = async (req, res) => {
    const targetBlob = Number(req.body?.blobId || req.body?.blob || req.params?.blobId);
    const hexBlobId = toHexBlobId(targetBlob);
    const userAgent = req.headers['user-agent'] || 'unknown';
    logger.info(`GET/POST /xblob/XBlobRead blob=${targetBlob} from User-Agent "${userAgent}"`);
    try {
      const blobData = await xintent.XBlobRead(X, routerWin(), targetBlob);
      res.setHeader('Matchbox-Bridge', '1.0');
      res.setHeader('X-Blob-Id', hexBlobId);
      res.setHeader('Accept-Encoding', 'identity, base64, fd-rights');

      const acceptHeader = req.headers['accept'] || '';
      const isRawHttpRequested = req.method === 'GET' || acceptHeader.includes('*/*') || acceptHeader.includes('audio/') || acceptHeader.includes('image/') || acceptHeader.includes('text/') || acceptHeader.includes('application/octet-stream') || req.query?.format === 'http';

      if (isRawHttpRequested && !req.body?.json) {
        const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'application/octet-stream');
        const dataType = blobData._dataType || (mimeType.includes('application/json') ? 'json' : 'binary');
        const isStream = blobData.xblobType === 'ReadableStream' || blobData.xblobType === 'MediaStream' || req.headers['x-xblob-type'] === 'ReadableStream';

        let bodyPayload = blobData.data !== undefined ? blobData.data : blobData;

        // Check if payload is an open file descriptor or file path (e.g. /proc/self/fd/N or disk path)
        const fdPath = typeof bodyPayload === 'string' ? bodyPayload.trim() : null;
        if (fdPath && (fdPath.startsWith('/proc/') || fdPath.startsWith('/dev/') || fs.existsSync(fdPath))) {
          const headers = {
            'Content-Type': mimeType,
            'X-XBlob-Type': blobData.xblobType || 'ReadableStream',
            'X-Blob-Id': hexBlobId,
            'Accept-Encoding': 'identity, base64, fd-rights',
            'Matchbox-Bridge': '1.0'
          };
          if (blobData.name) {
            headers['Content-Disposition'] = `inline; filename="${blobData.name}"`;
          }
          if (!isStream && blobData.size !== undefined) {
            headers['Content-Length'] = blobData.size;
          }
          res.writeHead(200, headers);
          const fileStream = fs.createReadStream(fdPath);
          return fileStream.pipe(res);
        }

        let bodyBuf;
        if (Buffer.isBuffer(bodyPayload)) {
          bodyBuf = bodyPayload;
        } else if (typeof bodyPayload === 'object') {
          bodyBuf = Buffer.from(JSON.stringify(bodyPayload), 'utf8');
        } else {
          bodyBuf = Buffer.from(String(bodyPayload), 'utf8');
        }

        res.setHeader('Content-Type', mimeType);
        if (!isStream) {
          res.setHeader('Content-Length', blobData.size !== undefined ? blobData.size : bodyBuf.length);
        }
        const contentEnc = blobData.contentEncoding || (dataType === 'fd-rights' ? 'fd-rights' : (dataType === 'base64' ? 'base64' : null));
        if (contentEnc && contentEnc !== 'identity') {
          res.setHeader('Content-Encoding', contentEnc);
        }
        if (blobData.name) {
          res.setHeader('Content-Disposition', `attachment; filename="${blobData.name}"`);
        } else if (!mimeType.includes('application/json')) {
          res.setHeader('Content-Disposition', 'inline');
        }
        res.setHeader('X-XBlob-Type', blobData.xblobType || 'Blob');

        return res.status(200).send(bodyBuf);
      }

      res.status(200).json({ status: 'ok', blobId: hexBlobId, blob: blobData });
    } catch (err) {
      res.status(404).json({ status: 'error', message: err.message });
    }
  };

  const parseBlobId = (id) => {
    if (id === null || id === undefined) return NaN;
    if (typeof id === 'number') return id;
    if (typeof id === 'string') {
      const trimmed = id.trim();
      if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
        return parseInt(trimmed, 16);
      }
      const num = Number(trimmed);
      if (!isNaN(num)) return num;
      return parseInt(trimmed, 16);
    }
    return NaN;
  };

  const routeXBlobTransfer = async (req, res) => {
    const { blobId, blob, grantee } = req.body || {};
    const rawBlob = req.params?.blobId || blobId || blob;
    const targetBlob = parseBlobId(rawBlob);
    const hexBlobId = toHexBlobId(targetBlob);
    const granteeWin = Number(grantee || routerWin());
    logger.info(`${req.method} ${req.path} blob=${targetBlob} grantee=${granteeWin}`);
    if (isNaN(targetBlob)) {
      res.setHeader('Matchbox-Bridge', '1.0');
      return res.status(400).json({ status: 'error', message: 'Invalid blobId' });
    }
    await xintent.XBlobTransfer(X, routerWin(), clientWin, targetBlob, granteeWin);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.setHeader('X-Blob-Id', hexBlobId);
    res.status(200).json({ status: 'ok', blobId: hexBlobId });
  };

  const routeXBlobGrant = async (req, res) => {
    const { blobId, blob, grantee } = req.body || {};
    const rawBlob = req.params?.blobId || blobId || blob;
    const targetBlob = parseBlobId(rawBlob);
    const hexBlobId = toHexBlobId(targetBlob);
    const granteeWin = Number(grantee || routerWin());
    logger.info(`${req.method} ${req.path} blob=${targetBlob} grantee=${granteeWin}`);
    if (isNaN(targetBlob)) {
      res.setHeader('Matchbox-Bridge', '1.0');
      return res.status(400).json({ status: 'error', message: 'Invalid blobId' });
    }
    await xintent.XBlobGrant(X, routerWin(), clientWin, targetBlob, granteeWin);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.setHeader('X-Blob-Id', hexBlobId);
    res.status(200).json({ status: 'ok', blobId: hexBlobId });
  };

  const routeXBlobUnlink = async (req, res) => {
    const { blobId, blob } = req.body || {};
    const rawBlob = req.params?.blobId || blobId || blob;
    const targetBlob = parseBlobId(rawBlob);
    const hexBlobId = toHexBlobId(targetBlob);
    logger.info(`${req.method} ${req.path} blob=${targetBlob}`);
    if (isNaN(targetBlob)) {
      res.setHeader('Matchbox-Bridge', '1.0');
      return res.status(400).json({ status: 'error', message: 'Invalid blobId' });
    }
    await xintent.XBlobUnlink(X, routerWin(), clientWin, targetBlob);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.setHeader('X-Blob-Id', hexBlobId);
    res.status(200).json({ status: 'ok', blobId: hexBlobId });
  };

  const routeXBlobAnnounceHost = async (req, res) => {
    const { blobId, blob, host } = req.body || {};
    const rawBlob = req.params?.blobId || blobId || blob;
    const targetBlob = parseBlobId(rawBlob);
    const hexBlobId = toHexBlobId(targetBlob);
    const hostWin = Number(host || clientWin);
    logger.info(`${req.method} ${req.path} blob=${targetBlob} host=${hostWin}`);
    if (isNaN(targetBlob)) {
      res.setHeader('Matchbox-Bridge', '1.0');
      return res.status(400).json({ status: 'error', message: 'Invalid blobId' });
    }
    await xintent.XBlobAnnounceHost(X, routerWin(), clientWin, targetBlob, hostWin);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.setHeader('X-Blob-Id', hexBlobId);
    res.status(200).json({ status: 'ok', blobId: hexBlobId });
  };

  const routeXBlobBroadcast = async (req, res) => {
    const { blobId, blob, host, version } = req.body || {};
    const rawBlob = req.params?.blobId || blobId || blob;
    const targetBlob = parseBlobId(rawBlob);
    const hexBlobId = toHexBlobId(targetBlob);
    logger.info(`${req.method} ${req.path} blob=${targetBlob} version=${version}`);
    if (isNaN(targetBlob)) {
      res.setHeader('Matchbox-Bridge', '1.0');
      return res.status(400).json({ status: 'error', message: 'Invalid blobId' });
    }
    await xintent.XBlobBroadcast(X, routerWin(), clientWin, targetBlob, host, version);
    res.setHeader('Matchbox-Bridge', '1.0');
    res.setHeader('Accept-Encoding', 'identity, base64, fd-rights');
    res.setHeader('X-Blob-Id', hexBlobId);
    res.status(200).json({ status: 'ok', blobId: hexBlobId, blob: hexBlobId });
  };

  return {
    routeXBlobCreate,
    routeXBlobRead,
    routeXBlobTransfer,
    routeXBlobGrant,
    routeXBlobUnlink,
    routeXBlobAnnounceHost,
    routeXBlobBroadcast,
  };
};
