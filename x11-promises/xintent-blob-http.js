const fs = require('fs');
const http = require('http');
const os = require('os');
const { formatXBlobAtRest, parseXBlobAtRest } = require('./xintent-at-rest');

function parseBlobIdNumber(id) {
  if (typeof id === 'number') return id;
  if (typeof id === 'string' && (id.startsWith('0x') || id.startsWith('0X'))) {
    return parseInt(id, 16);
  }
  return Number(id);
}

function toHexBlobId(id) {
  if (id === null || id === undefined) return null;
  const num = parseBlobIdNumber(id);
  if (isNaN(num)) return id;
  return `0x${num.toString(16)}`;
}

function normalizeSocketBlobData(blobData) {
  if (typeof blobData === 'number' && blobData >= 0) {
    return {
      data: `/proc/${process.pid}/fd/${blobData}`,
      _dataType: 'file-path',
      contentEncoding: 'file-path',
    };
  }
  if (typeof blobData === 'object' && blobData !== null) {
    if (typeof blobData.data === 'number' && blobData.data >= 0) {
      return Object.assign({}, blobData, {
        data: `/proc/${process.pid}/fd/${blobData.data}`,
        _dataType: 'file-path',
        contentEncoding: 'file-path',
      });
    }
    if (blobData._dataType === 'fd-rights' || blobData.contentEncoding === 'fd-rights') {
      return Object.assign({}, blobData, {
        _dataType: 'file-path',
        contentEncoding: 'file-path',
      });
    }
  }
  return blobData;
}

function serializePutBody(blobData) {
  if (Buffer.isBuffer(blobData)) return blobData;
  if (typeof blobData === 'string') return Buffer.from(blobData, 'utf8');
  if (typeof blobData === 'object' && blobData !== null) {
    if (blobData._dataType === 'binary' && Buffer.isBuffer(blobData.data)) {
      return blobData.data;
    }
    return Buffer.from(formatXBlobAtRest(blobData), 'utf8');
  }
  return Buffer.from(String(blobData), 'utf8');
}

function resolvePutContentEncoding(blobData) {
  if (typeof blobData !== 'object' || blobData === null) return 'identity';
  if (blobData.contentEncoding) return blobData.contentEncoding;
  if (blobData._dataType === 'fd-rights' || blobData._dataType === 'base64') {
    return blobData._dataType;
  }
  return 'identity';
}

function buildPutHeaders(blobData, bodyBuf, senderWin) {
  const mimeType = (typeof blobData === 'object' && blobData !== null && blobData.type)
    ? blobData.type
    : 'application/json';
  const hostname = os.hostname();
  const display = (process.env.DISPLAY || ':0').replace(/^:/, '');
  const widHex = typeof senderWin === 'number' ? `0x${senderWin.toString(16)}` : String(senderWin);

  const headers = {
    'Content-Type': mimeType,
    'Content-Length': bodyBuf.length,
    'Content-Encoding': resolvePutContentEncoding(blobData),
    'Accept-Encoding': 'identity, base64, fd-rights',
    'Origin': `${hostname}:${display}/${widHex}`,
  };
  if (typeof blobData === 'object' && blobData !== null) {
    if (blobData.name) headers['Content-Disposition'] = `attachment; filename="${blobData.name}"`;
    if (blobData.xblobType) headers['X-XBlob-Type'] = blobData.xblobType;
  }
  return headers;
}

function parsePutResponse(res, resData, targetBlobId, transportLabel) {
  const json = JSON.parse(resData);
  const rawBlob = res.headers['x-blob-id'] || json.blobId || json.blob || targetBlobId;
  const blobId = parseBlobIdNumber(rawBlob);
  if (!isNaN(blobId) && blobId > 0) {
    return blobId;
  }
  throw new Error(`Invalid blob ID returned from ${transportLabel}: ${resData}`);
}

function executePutBlobRequest(reqOptions, bodyBuf, targetBlobId, timeoutMsg, transportLabel) {
  return new Promise((resolve, reject) => {
    const req = http.request(reqOptions, (res) => {
      let resData = '';
      res.on('data', (chunk) => { resData += chunk; });
      res.on('end', () => {
        try {
          resolve(parsePutResponse(res, resData, targetBlobId, transportLabel));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error(timeoutMsg));
    });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

async function httpPutBlobsOverSocket(sockPath, blobData, senderWin, targetBlobId = null) {
  if (!senderWin) {
    throw new Error('httpPutBlobsOverSocket requires senderWin');
  }
  const normalizedData = normalizeSocketBlobData(blobData);
  const bodyBuf = serializePutBody(normalizedData);
  const headers = buildPutHeaders(normalizedData, bodyBuf, senderWin);
  const pathStr = targetBlobId ? `/blobs/${toHexBlobId(targetBlobId)}` : '/blobs';

  return executePutBlobRequest(
    { socketPath: sockPath, path: pathStr, method: 'PUT', headers },
    bodyBuf,
    targetBlobId,
    'Socket PUT /blobs timeout',
    'socket'
  );
}

async function httpPutBlobsOverHttp(port, blobData, senderWin, targetBlobId = null) {
  const bodyBuf = serializePutBody(blobData);
  const headers = buildPutHeaders(blobData, bodyBuf, senderWin);
  const pathStr = targetBlobId ? `/blobs/${toHexBlobId(targetBlobId)}` : '/blobs';

  return executePutBlobRequest(
    { hostname: 'localhost', port, path: pathStr, method: 'PUT', headers },
    bodyBuf,
    targetBlobId,
    'HTTP PUT /blobs timeout',
    'http'
  );
}

function buildXBlobUserAgent(win = 0, appId = 'xintent') {
  const host = os.hostname();
  const display = process.env.DISPLAY || '';
  const winHex = typeof win === 'number' ? `0x${win.toString(16)}` : String(win || '0x0');
  return `${host}:${display}/${winHex} (app=${appId})`;
}

function isFilePathBlobResponse(contentType, blobData) {
  if (contentType && contentType.includes('file-path')) return true;
  if (!blobData) return false;
  return blobData._dataType === 'file-path' || blobData.contentEncoding === 'file-path';
}

function openFilePathToFdIfNeeded(contentType, blobData) {
  if (!isFilePathBlobResponse(contentType, blobData)) return;
  const filePath = blobData.data;
  if (typeof filePath === 'string' && fs.existsSync(filePath)) {
    try {
      const fd = fs.openSync(filePath, 'r');
      blobData.data = fd;
      blobData._dataType = 'fd-rights';
      blobData.contentEncoding = 'fd-rights';
    } catch (_) {}
  }
}

function tryParseJsonGetResponse(res, bodyBuf) {
  const contentType = res.headers['content-type'] || '';
  if (!contentType.includes('application/json') && !contentType.includes('file-path')) {
    return null;
  }
  try {
    const resJson = JSON.parse(bodyBuf.toString('utf8'));
    const blobData = resJson.blob || resJson;
    openFilePathToFdIfNeeded(contentType, blobData);
    return blobData;
  } catch (_) {
    return null;
  }
}

const HTTP_TO_REST_HEADER_MAP = [
  ['content-type', 'Content-Type'],
  ['content-length', 'Content-Length'],
  ['content-encoding', 'Content-Encoding'],
  ['content-disposition', 'Content-Disposition'],
  ['x-xblob-type', 'X-XBlob-Type'],
];

function buildRawRestFromHttpResponse(res, bodyBuf) {
  const headers = [];
  for (const [lowerKey, canonicalKey] of HTTP_TO_REST_HEADER_MAP) {
    if (res.headers[lowerKey]) {
      headers.push(`${canonicalKey}: ${res.headers[lowerKey]}`);
    }
  }
  return Buffer.concat([
    Buffer.from(headers.join('\r\n') + '\r\n\r\n', 'utf8'),
    bodyBuf,
  ]);
}

function handleGetBlobResponse(res, chunks, hexBlobId, transportLabel, resolve, reject) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    reject(new Error(`GET /blobs/${hexBlobId} over ${transportLabel} returned status ${res.statusCode}`));
    return;
  }
  const bodyBuf = Buffer.concat(chunks);
  const jsonBlob = tryParseJsonGetResponse(res, bodyBuf);
  if (jsonBlob !== null) {
    resolve(jsonBlob);
    return;
  }
  try {
    resolve(parseXBlobAtRest(buildRawRestFromHttpResponse(res, bodyBuf)));
  } catch (err) {
    reject(err);
  }
}

function executeGetBlobRequest(reqOptions, hexBlobId, timeoutMsg, transportLabel) {
  return new Promise((resolve, reject) => {
    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => handleGetBlobResponse(res, chunks, hexBlobId, transportLabel, resolve, reject));
    });
    req.setTimeout(5000, () => {
      req.destroy(new Error(timeoutMsg));
    });
    req.on('error', reject);
    req.end();
  });
}

function buildGetRequestHeaders(userAgent) {
  return {
    'User-Agent': userAgent || buildXBlobUserAgent(0, 'xintent'),
    'Accept': 'application/json, */*',
    'Accept-Encoding': 'identity, base64, fd-rights',
  };
}

function httpGetBlobOverSocket(sockPath, hexBlobId, userAgent) {
  return executeGetBlobRequest(
    {
      socketPath: sockPath,
      path: `/blobs/${hexBlobId}`,
      method: 'GET',
      headers: buildGetRequestHeaders(userAgent),
    },
    hexBlobId,
    `Socket GET /blobs/${hexBlobId} timeout`,
    'socket'
  );
}

function httpGetBlobOverHttp(port, hexBlobId, userAgent) {
  return executeGetBlobRequest(
    {
      hostname: 'localhost',
      port,
      path: `/blobs/${hexBlobId}`,
      method: 'GET',
      headers: buildGetRequestHeaders(userAgent),
    },
    hexBlobId,
    `HTTP GET /blobs/${hexBlobId} timeout`,
    'HTTP'
  );
}

async function getXBlobSocketPath(X, hostWin, atoms = {}) {
  if (!hostWin) return null;
  const socketPathAtom = atoms['XBLOB_SOCKET_PATH'] || (await X.InternAtom(false, 'XBLOB_SOCKET_PATH'));
  try {
    const prop = await X.GetProperty(0, hostWin, socketPathAtom, 0, 0, 1024);
    if (prop && prop.data && prop.data.length > 0) {
      return prop.data.toString('utf8');
    }
  } catch (_) {}
  return null;
}

module.exports = {
  toHexBlobId,
  buildXBlobUserAgent,
  httpPutBlobsOverSocket,
  httpPutBlobsOverHttp,
  httpGetBlobOverSocket,
  httpGetBlobOverHttp,
  getXBlobSocketPath,
};
