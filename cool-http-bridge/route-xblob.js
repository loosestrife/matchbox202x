const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const xintent = require('../x11-promises/xintent');
const { Logger } = require('../server-tools');

const logger = new Logger({ module: 'route-xblob' });

const parseBlobId = (id) => {
  if (id === null || id === undefined) return NaN;
  if (typeof id === 'number') return id;
  if (typeof id === 'string') {
    const trimmed = id.trim();
    if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
      return parseInt(trimmed, 16);
    }
    const num = Number(trimmed);
    return !isNaN(num) ? num : parseInt(trimmed, 16);
  }
  return NaN;
};

const toHexBlobId = (id) => {
  if (id === null || id === undefined) return null;
  const num = parseBlobId(id);
  return isNaN(num) ? id : `0x${num.toString(16)}`;
};

function createTempFdForBuffer(req, bodyBuf) {
  const blobDir = '/tmp/xintent_blobs';
  if (!fs.existsSync(blobDir)) fs.mkdirSync(blobDir, { recursive: true });
  const fileName = req.headers['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1] || `blob_${Date.now()}`;
  const tempPath = path.join(blobDir, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${path.basename(fileName)}`);
  const fd = fs.openSync(tempPath, 'w+');
  fs.writeSync(fd, bodyBuf);
  try { fs.unlinkSync(tempPath); } catch (_) {}
  return `/proc/${process.pid}/fd/${fd}`;
}

function extractRawUploadEncodingAndData(req) {
  const transferEnc = (req.headers['content-encoding'] || req.headers['content-transfer-encoding'] || '').toLowerCase();
  if (transferEnc.includes('fd-rights') || transferEnc.includes('base64')) {
    const dataType = transferEnc.includes('fd-rights') ? 'fd-rights' : 'base64';
    const dataVal = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    return { dataType, dataVal, contentEncoding: dataType };
  }
  if (Buffer.isBuffer(req.body)) {
    return {
      dataType: 'fd-rights',
      dataVal: createTempFdForBuffer(req, req.body),
      contentEncoding: 'fd-rights',
    };
  }
  const dataVal = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  return { dataType: 'text', dataVal, contentEncoding: null };
}

function parseBlobCreatePayload(req) {
  if (typeof req.body === 'string' && (req.body.includes('Content-Type:') || req.body.includes('X-XBlob-Type:'))) {
    return xintent.parseXBlobAtRest(req.body);
  }
  const contentType = req.headers['content-type'];
  if (!contentType || contentType.includes('application/json')) {
    return req.body || {};
  }

  const { dataType, dataVal, contentEncoding } = extractRawUploadEncodingAndData(req);
  const contentLen = req.headers['content-length'];
  const computedSize = Buffer.isBuffer(dataVal) ? dataVal.length : Buffer.byteLength(String(dataVal), 'utf8');

  return {
    xblobType: req.headers['x-xblob-type'] || 'Blob',
    type: contentType,
    size: contentLen ? parseInt(contentLen, 10) : computedSize,
    name: req.headers['content-disposition']?.match(/filename="?([^";]+)"?/)?.[1] || null,
    _dataType: dataType,
    contentEncoding,
    data: dataVal,
  };
}

function wantsRawHttpBlobResponse(req) {
  if (req.body?.json) return false;
  if (req.method === 'GET' || req.query?.format === 'http') return true;
  const acceptHeader = req.headers['accept'] || '';
  const rawTypes = ['*/*', 'audio/', 'image/', 'text/', 'application/octet-stream'];
  return rawTypes.some((t) => acceptHeader.includes(t));
}

function tryPipeFdStream(res, blobData, mimeType, isStream, hexBlobId) {
  const bodyPayload = blobData.data !== undefined ? blobData.data : blobData;
  const fdPath = typeof bodyPayload === 'string' ? bodyPayload.trim() : null;
  if (!fdPath || (!fdPath.startsWith('/proc/') && !fdPath.startsWith('/dev/'))) {
    return false;
  }
  const headers = {
    'Content-Type': mimeType,
    'X-XBlob-Type': blobData.xblobType || 'ReadableStream',
    'X-Blob-Id': hexBlobId,
    'Accept-Encoding': 'identity, base64, fd-rights',
    'Matchbox-Bridge': '1.0',
  };
  if (blobData.name) headers['Content-Disposition'] = `inline; filename="${blobData.name}"`;
  if (!isStream && blobData.size !== undefined) headers['Content-Length'] = blobData.size;
  res.writeHead(200, headers);
  fs.createReadStream(fdPath).pipe(res);
  return true;
}

function convertBlobPayloadToBuffer(blobData) {
  const bodyPayload = blobData.data !== undefined ? blobData.data : blobData;
  if (Buffer.isBuffer(bodyPayload)) return bodyPayload;
  if (typeof bodyPayload === 'string') {
    if (blobData._dataType === 'base64' || blobData.contentEncoding === 'base64') {
      try {
        return Buffer.from(bodyPayload, 'base64');
      } catch (_) {
        return Buffer.from(bodyPayload, 'utf8');
      }
    }
    return Buffer.from(bodyPayload, 'utf8');
  }
  if (typeof bodyPayload === 'object') return Buffer.from(JSON.stringify(bodyPayload), 'utf8');
  return Buffer.from(String(bodyPayload), 'utf8');
}

function sendRawHttpBlob(req, res, blobData, hexBlobId) {
  const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'application/octet-stream');
  const dataType = blobData._dataType || (mimeType.includes('application/json') ? 'json' : 'binary');
  const isStream = blobData.xblobType === 'ReadableStream' || blobData.xblobType === 'MediaStream' || req.headers['x-xblob-type'] === 'ReadableStream';

  if (tryPipeFdStream(res, blobData, mimeType, isStream, hexBlobId)) {
    return;
  }

  const bodyBuf = convertBlobPayloadToBuffer(blobData);
  res.setHeader('Content-Type', mimeType);
  if (!isStream) {
    res.setHeader('Content-Length', blobData.size !== undefined ? blobData.size : bodyBuf.length);
  }
  if (dataType === 'fd-rights') {
    res.setHeader('Content-Encoding', 'fd-rights');
  }
  if (blobData.name) {
    res.setHeader('Content-Disposition', `attachment; filename="${blobData.name}"`);
  } else if (!mimeType.includes('application/json')) {
    res.setHeader('Content-Disposition', 'inline');
  }
  res.setHeader('X-XBlob-Type', blobData.xblobType || 'Blob');
  return res.status(200).send(bodyBuf);
}

module.exports = ({ X, clientWin }) => {
  const routerWin = () => xintent.routerWin;

  const routeXBlobCreate = async (req, res) => {
    const blobData = parseBlobCreatePayload(req);
    const rawBlob = req.params?.blobId;
    const targetBlob = rawBlob ? parseBlobId(rawBlob) : null;

    let blobId = targetBlob;
    if (targetBlob) {
      await xintent.XBlobWrite(X, routerWin(), clientWin, targetBlob, blobData);
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

      if (wantsRawHttpBlobResponse(req)) {
        return sendRawHttpBlob(req, res, blobData, hexBlobId);
      }
      res.status(200).json({ status: 'ok', blobId: hexBlobId, blob: blobData });
    } catch (err) {
      res.status(404).json({ status: 'error', message: err.message });
    }
  };

  const routeXBlobTransfer = async (req, res) => {
    const { blobId, blob, grantee } = req.body || {};
    const targetBlob = parseBlobId(req.params?.blobId || blobId || blob);
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
    const targetBlob = parseBlobId(req.params?.blobId || blobId || blob);
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
    const targetBlob = parseBlobId(req.params?.blobId || blobId || blob);
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
    const targetBlob = parseBlobId(req.params?.blobId || blobId || blob);
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
    const targetBlob = parseBlobId(req.params?.blobId || blobId || blob);
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
