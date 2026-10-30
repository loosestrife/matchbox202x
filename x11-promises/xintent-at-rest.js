const RESERVED_HEADERS = new Set([
  'content-type',
  'content-length',
  'content-encoding',
  'accept-encoding',
  'content-disposition',
  'x-xblob-type',
]);

function isBlobWrapper(blobData) {
  if (typeof blobData !== 'object' || blobData === null || Buffer.isBuffer(blobData)) {
    return false;
  }
  if (blobData.intent || blobData.event || blobData.action) {
    return false;
  }
  return blobData.data !== undefined || blobData.xblobType !== undefined;
}

function serializeWrapperData(data, initialDataType) {
  if (Buffer.isBuffer(data)) {
    return { bodyBuf: data, dataType: initialDataType || 'binary' };
  }
  if (typeof data === 'object' && data !== null) {
    return { bodyBuf: Buffer.from(JSON.stringify(data), 'utf8'), dataType: initialDataType || 'json' };
  }
  return { bodyBuf: Buffer.from(String(data ?? ''), 'utf8'), dataType: initialDataType || null };
}

function extractWrapperFields(blobData) {
  const { bodyBuf, dataType } = serializeWrapperData(blobData.data, blobData._dataType || null);
  return {
    xblobType: blobData.xblobType || 'Blob',
    name: blobData.name || null,
    type: blobData.type || null,
    size: blobData.size !== undefined ? blobData.size : null,
    dataType,
    bodyBuf,
  };
}

function extractDirectFields(blobData) {
  if (Buffer.isBuffer(blobData)) {
    return { xblobType: 'Blob', name: null, type: null, size: null, dataType: 'binary', bodyBuf: blobData };
  }
  if (typeof blobData === 'object' && blobData !== null) {
    return {
      xblobType: 'Blob',
      name: null,
      type: 'application/json',
      size: null,
      dataType: 'json',
      bodyBuf: Buffer.from(JSON.stringify(blobData), 'utf8'),
    };
  }
  return {
    xblobType: 'Blob',
    name: null,
    type: null,
    size: null,
    dataType: null,
    bodyBuf: Buffer.from(String(blobData), 'utf8'),
  };
}

function resolveDataType(dataType, type) {
  if (dataType) return dataType;
  if (type && (type.includes('application/json') || type.endsWith('+json'))) {
    return 'json';
  }
  return 'text';
}

function resolveMimeType(type, dataType) {
  if (type) return type;
  if (dataType === 'json') return 'application/json';
  if (dataType === 'base64' || dataType === 'binary') return 'application/octet-stream';
  return 'text/plain';
}

function resolveContentEncoding(blobData, dataType) {
  if (blobData.contentEncoding) return blobData.contentEncoding;
  const effType = dataType || blobData._dataType;
  if (effType === 'fd-rights' || effType === 'file-path' || effType === 'base64') {
    return effType;
  }
  return null;
}

function resolveAcceptEncoding(blobData) {
  if (blobData.acceptEncoding) return blobData.acceptEncoding;
  if (!blobData.headers) return null;
  return blobData.headers['accept-encoding'] || blobData.headers['Accept-Encoding'] || null;
}

function appendExtraHeaders(headers, blobData) {
  if (typeof blobData !== 'object' || blobData === null) return;
  const extraHeaders = blobData.headers || blobData.messageHeaders;
  if (!extraHeaders || typeof extraHeaders !== 'object') return;
  for (const [k, v] of Object.entries(extraHeaders)) {
    if (!RESERVED_HEADERS.has(k.toLowerCase())) {
      headers.push(`${k}: ${v}`);
    }
  }
}

function formatXBlobAtRest(blobData) {
  const normalized = (blobData === null || blobData === undefined) ? {} : blobData;
  const fields = isBlobWrapper(normalized)
    ? extractWrapperFields(normalized)
    : extractDirectFields(normalized);

  const dataType = resolveDataType(fields.dataType, fields.type);
  const type = resolveMimeType(fields.type, dataType);
  const size = (fields.size === null || fields.size === undefined) ? fields.bodyBuf.length : fields.size;
  let xblobType = fields.xblobType;

  const headers = [`Content-Type: ${type}`, `Content-Length: ${size}`];
  const contentEnc = resolveContentEncoding(normalized, dataType);
  if (contentEnc && contentEnc !== 'identity') {
    headers.push(`Content-Encoding: ${contentEnc}`);
  }
  const acceptEnc = resolveAcceptEncoding(normalized);
  if (acceptEnc) {
    headers.push(`Accept-Encoding: ${acceptEnc}`);
  }
  if (fields.name) {
    headers.push(`Content-Disposition: attachment; filename="${fields.name}"`);
    if (!normalized.xblobType) xblobType = 'File';
  }
  headers.push(`X-XBlob-Type: ${xblobType}`);
  appendExtraHeaders(headers, normalized);

  const headerBuf = Buffer.from(headers.join('\r\n') + '\r\n\r\n', 'utf8');
  return Buffer.concat([headerBuf, fields.bodyBuf]);
}

function toRawBuffer(raw) {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.from(raw);
  return Buffer.from(String(raw), 'utf8');
}

function splitHeaderAndBody(rawBuf) {
  const crlfPos = rawBuf.indexOf('\r\n\r\n');
  if (crlfPos !== -1) {
    return {
      headerText: rawBuf.slice(0, crlfPos).toString('utf8'),
      bodyBuf: rawBuf.slice(crlfPos + 4),
    };
  }
  const lfPos = rawBuf.indexOf('\n\n');
  if (lfPos !== -1) {
    return {
      headerText: rawBuf.slice(0, lfPos).toString('utf8'),
      bodyBuf: rawBuf.slice(lfPos + 2),
    };
  }
  return {
    headerText: rawBuf.toString('utf8'),
    bodyBuf: Buffer.alloc(0),
  };
}

function parseHeaderLines(headerText) {
  const headers = {};
  for (const line of headerText.split(/\r?\n/)) {
    const colonPos = line.indexOf(':');
    if (colonPos !== -1) {
      const key = line.slice(0, colonPos).trim().toLowerCase();
      headers[key] = line.slice(colonPos + 1).trim();
    }
  }
  return headers;
}

function extractDispositionFilename(contentDisp) {
  if (!contentDisp) return null;
  const fnMatch = contentDisp.match(/filename\s*=\s*"?([^";]+)"?/i);
  return fnMatch ? fnMatch[1] : null;
}

function decodeByTransferEncoding(bodyBuf, transferEnc) {
  const lowerEnc = transferEnc.toLowerCase().trim();
  if (lowerEnc.includes('fd-rights')) {
    return { data: bodyBuf.toString('utf8').trim(), dataType: 'fd-rights' };
  }
  if (lowerEnc.includes('base64')) {
    try {
      return { data: Buffer.from(bodyBuf.toString('utf8').trim(), 'base64'), dataType: 'binary' };
    } catch (_) {
      return { data: bodyBuf.toString('utf8'), dataType: 'base64' };
    }
  }
  if (lowerEnc.includes('identity')) {
    return { data: bodyBuf.toString('utf8'), dataType: 'text' };
  }
  return { data: bodyBuf, dataType: 'binary' };
}

function decodeByContentType(bodyBuf, contentType) {
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return { data: JSON.parse(bodyBuf.toString('utf8')), dataType: 'json' };
    } catch (_) {
      return { data: bodyBuf.toString('utf8'), dataType: 'text' };
    }
  }
  if (contentType.startsWith('text/')) {
    return { data: bodyBuf.toString('utf8'), dataType: 'text' };
  }
  return { data: bodyBuf, dataType: 'binary' };
}

function resolveParsedContentEncoding(transferEnc, dataType) {
  if (transferEnc) return transferEnc;
  if (dataType === 'fd-rights' || dataType === 'base64') return dataType;
  return 'identity';
}

function parseXBlobAtRest(raw) {
  if (!raw) {
    return {
      xblobType: 'Blob',
      type: 'text/plain',
      size: 0,
      name: null,
      headers: {},
      data: Buffer.alloc(0),
      _dataType: 'text',
    };
  }

  const rawBuf = toRawBuffer(raw);
  const { headerText, bodyBuf } = splitHeaderAndBody(rawBuf);
  const headers = parseHeaderLines(headerText);

  const contentType = headers['content-type'] || 'application/octet-stream';
  const parsedSize = headers['content-length'] ? parseInt(headers['content-length'], 10) : bodyBuf.length;
  const size = isNaN(parsedSize) ? bodyBuf.length : parsedSize;
  const name = extractDispositionFilename(headers['content-disposition']);
  const xblobType = headers['x-xblob-type'] || headers['x-blob-type'] || 'Blob';
  const transferEnc = headers['content-encoding'] || headers['content-transfer-encoding'];

  const { data, dataType } = transferEnc
    ? decodeByTransferEncoding(bodyBuf, transferEnc)
    : decodeByContentType(bodyBuf, contentType);

  return {
    xblobType,
    type: contentType,
    size,
    name,
    headers,
    data,
    _dataType: dataType,
    contentEncoding: resolveParsedContentEncoding(transferEnc, dataType),
  };
}

module.exports = {
  formatXBlobAtRest,
  parseXBlobAtRest,
};
