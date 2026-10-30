const fs = require('fs');
const { HttpError } = require('../server-tools');
const xintent = require('../x11-promises/xintent');

function resolveStringBlob(bodyPayload, blobData) {
  if (fs.existsSync(bodyPayload)) {
    try {
      return fs.readFileSync(bodyPayload);
    } catch (_) {
      return Buffer.from(bodyPayload, 'utf8');
    }
  }
  if (blobData._dataType === 'base64' || blobData.contentEncoding === 'base64') {
    try {
      return Buffer.from(bodyPayload, 'base64');
    } catch (_) {
      return Buffer.from(bodyPayload, 'utf8');
    }
  }
  return Buffer.from(bodyPayload, 'utf8');
}

function serializeBlobPayloadToBuffer(blobData) {
  const bodyPayload = blobData.data !== undefined ? blobData.data : blobData;
  if (Buffer.isBuffer(bodyPayload)) return bodyPayload;
  if (typeof bodyPayload === 'number' && bodyPayload >= 0) {
    try {
      return fs.readFileSync(`/proc/self/fd/${bodyPayload}`);
    } catch (_) {
      return Buffer.alloc(0);
    }
  }
  if (typeof bodyPayload === 'string') return resolveStringBlob(bodyPayload, blobData);
  if (typeof bodyPayload === 'object') return Buffer.from(JSON.stringify(bodyPayload), 'utf8');
  return Buffer.from(String(bodyPayload), 'utf8');
}

function ensureMultipartHeaders(res, state, boundary) {
  if (state.headersSent) return;
  res.writeHead(200, {
    'Content-Type': `multipart/mixed; boundary=${boundary}`,
    'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Connection': 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
    'Matchbox-Bridge': '1.0',
  });
  state.headersSent = true;
}

function writeJsonFrame(res, state, boundary, data, customHeaders = {}) {
  if (res.writableEnded || res.finished) return;
  ensureMultipartHeaders(res, state, boundary);
  const jsonBody = JSON.stringify(data, null, 2);
  const headers = [
    'Content-Type: application/json',
    'Content-Disposition: inline',
    `Content-Length: ${Buffer.byteLength(jsonBody)}`,
    ...Object.entries(customHeaders).map(([key, val]) => `${key}: ${val}`),
  ];

  res.write(`--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n${jsonBody}\r\n\r\n`);
  if (typeof res.flush === 'function') {
    try { res.flush(); } catch (_) {}
  }
}

function writeXBlobFrame(res, state, boundary, logger, blobData, customHeaders = {}) {
  if (res.writableEnded || res.finished) return;
  ensureMultipartHeaders(res, state, boundary);

  const mimeType = blobData.type || (blobData._dataType === 'json' ? 'application/json' : 'application/octet-stream');
  const bodyBuf = serializeBlobPayloadToBuffer(blobData);
  const headers = [
    `Content-Type: ${mimeType}`,
    `Content-Length: ${bodyBuf.length}`,
  ];

  if (blobData.name) {
    headers.push(`Content-Disposition: attachment; filename="${blobData.name}"`);
  } else if (!mimeType.includes('application/json')) {
    headers.push('Content-Disposition: inline');
  }
  headers.push(`X-XBlob-Type: ${blobData.xblobType || 'Blob'}`);
  for (const [key, val] of Object.entries(customHeaders)) {
    headers.push(`${key}: ${val}`);
  }

  const headerBuf = Buffer.from(`--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n`, 'utf8');
  const footerBuf = Buffer.from('\r\n\r\n', 'utf8');

  res.write(Buffer.concat([headerBuf, bodyBuf, footerBuf]));
  logger.info(`route-intent: [HTTP STREAM] Wrote XBlob frame part to HTTP response stream (${bodyBuf.length} bytes, type: ${mimeType}, data_type: ${blobData?._dataType}, content_encoding: ${blobData?.contentEncoding})`);
  if (typeof res.flush === 'function') {
    try { res.flush(); } catch (_) {}
  }
}

function buildFrameCustomHeaders(blobId, controlWord, txId) {
  const headers = {};
  if (blobId) headers['X-Attached-Blob-Id'] = blobId;
  if (txId !== undefined) headers['X-Tx-Id'] = String(txId);
  if (controlWord !== undefined) {
    const ctrlStrings = [];
    if (controlWord & 1) ctrlStrings.push('SYN');
    if (controlWord & 2) ctrlStrings.push('FIN');
    if (ctrlStrings.length > 0) headers['X-Channel-Control'] = ctrlStrings.join(',');
  }
  return headers;
}

async function fetchAndWriteAttachedBlob({ X, res, state, boundary, logger, blobId, intent, payload }) {
  if (res.writableEnded || res.finished) return;
  try {
    const routerWin = xintent.routerWin || (await xintent.getValidRouterWin(X, X.rootWin || 0));
    const blob = await xintent.XBlobRead(X, routerWin, blobId);
    logger.info(`[route-intent] XBlobRead result for blobId=${blobId}: size=${blob?.size}, type=${blob?.type}, _dataType=${blob?._dataType}, contentEncoding=${blob?.contentEncoding}, isBuffer=${Buffer.isBuffer(blob?.data)}, dataLength=${Buffer.isBuffer(blob?.data) ? blob.data.length : (typeof blob?.data === 'string' ? blob.data.length : 'N/A')}`);
    if (blob && !res.writableEnded && !res.finished) {
      const hexBlobId = typeof blobId === 'number' ? `0x${blobId.toString(16)}` : String(blobId);
      writeXBlobFrame(res, state, boundary, logger, blob, { 'X-Blob-Id': hexBlobId });
    }
  } catch (err) {
    logger.error(`[BLOB READ ERROR] Failed to fetch blob ${blobId} for intent ${intent}: ${err.message}`, { intentPayload: payload });
  }
}

function finalizeStreamOnFin({ res, state, boundary, logger, senderWin, txId, controlWord, eventData, activeHttpAudioStreams, channelNatTable, deleteChannelSession, resolve }) {
  logger.info('Closing HTTP stream (FIN received)', { txId, controlWord });
  if (state.headersSent) {
    res.write(`--${boundary}--\r\n`);
    res.end();
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Tx-Id': String(txId) });
    res.end(JSON.stringify(eventData));
  }
  const cookieKey = eventData?.cookie || eventData?.OutputId;
  if (cookieKey) activeHttpAudioStreams.delete(cookieKey);
  if (typeof deleteChannelSession === 'function') {
    deleteChannelSession(senderWin, txId);
  } else {
    delete channelNatTable[txId];
  }
  resolve();
}

function createMessageFromXHandler(ctx) {
  const { X, req, res, state, boundary, logger, senderWin, txId, intent, payload, broadcastWsFrame, activeHttpAudioStreams, channelNatTable, deleteChannelSession, resolve } = ctx;
  return async (msg) => {
    if (res.writableEnded || res.finished) return;

    const eventData = msg?.payload || {};
    const controlWord = msg?.controlWord;
    const blobId = msg?.dataBlob || eventData?.data_blob || eventData?.blobId || eventData?.blob;

    logger.info(`route-intent: [HTTP STREAM] messageFromX XChannel ${txId}: ${xintent.frameDesc(msg)}`);
    if (typeof broadcastWsFrame === 'function' && eventData) {
      broadcastWsFrame(eventData);
    }

    const customIntentHeaders = buildFrameCustomHeaders(blobId, controlWord, txId);
    writeJsonFrame(res, state, boundary, eventData, customIntentHeaders);

    const preferVal = String(eventData?.Prefer || payload?.Prefer || req.headers['prefer'] || '').toLowerCase();
    const isMinimalPreferred = preferVal.includes('return=minimal') || payload?.receive_data === false || payload?.receiveData === false;

    if (blobId && !isMinimalPreferred) {
      await fetchAndWriteAttachedBlob({ X, res, state, boundary, logger, blobId, intent, payload });
    }

    const isFin = controlWord !== undefined && (controlWord & 2) !== 0;
    if (isFin && !res.writableEnded && !res.finished) {
      finalizeStreamOnFin({ res, state, boundary, logger, senderWin, txId, controlWord, eventData, activeHttpAudioStreams, channelNatTable, deleteChannelSession, resolve });
    }
  };
}

function validateAndNormalizeIntentPayload(req, intent) {
  const payload = req.body || {};
  if (req.query.app && !payload.app) {
    payload.app = req.query.app;
  }
  if (req.query.app && payload.app && req.query.app !== payload.app) {
    throw new HttpError(400, `advisory query string app specification (${req.query.app}) must match app specified in intent json (${payload.app}): ${JSON.stringify(payload)}`);
  }
  if (payload.intent && intent !== payload.intent) {
    throw new HttpError(400, `url path intent (${intent}) must match intent specified in intent json (${payload.intent}): ${JSON.stringify(payload)}`);
  }
  if (!payload.intent) {
    payload.intent = intent;
  }
  return payload;
}

function summarizeBlobForLog(blobObj) {
  return {
    name: blobObj.name,
    type: blobObj.type,
    size: blobObj.size,
    _dataType: blobObj._dataType,
  };
}

function buildIntentLogPayload(req, payload) {
  const logPayload = { ...payload };
  if (logPayload.dataBlob && typeof logPayload.dataBlob === 'object') {
    logPayload.dataBlob = summarizeBlobForLog(logPayload.dataBlob);
  }
  if (logPayload.blob && typeof logPayload.blob === 'object') {
    logPayload.blob = summarizeBlobForLog(logPayload.blob);
  }
  if (req.headers['x-channel']) logPayload['X-Channel'] = req.headers['x-channel'];
  if (req.headers['x-channel-control']) logPayload['X-Channel-Control'] = req.headers['x-channel-control'];
  if (req.headers['x-forwarded-by']) logPayload['X-Forwarded-By'] = req.headers['x-forwarded-by'];
  return logPayload;
}

function applyRequestHeadersToPayload(req, payload) {
  const preferReqHeader = (req.headers['prefer'] || '').toLowerCase();
  if (preferReqHeader.includes('return=minimal')) {
    payload.Prefer = 'return=minimal';
    payload.headers = payload.headers || {};
    payload.headers['Prefer'] = req.headers['prefer'];
  }
  if (req.headers['connection']) {
    payload.headers = payload.headers || {};
    payload.headers['Connection'] = req.headers['connection'];
  }
}

function parseChannelControlOptions(req, payload) {
  const channelControlHeader = req.headers['x-channel-control'];
  let reqControlWord = payload.controlWord;
  if (channelControlHeader) {
    reqControlWord = (channelControlHeader.includes('SYN') ? 1 : 0) | (channelControlHeader.includes('FIN') ? 2 : 0);
  }
  const hasChannelControl = Boolean(channelControlHeader) || reqControlWord !== undefined;
  const opensChannel = Boolean(hasChannelControl || payload.Accept || req.headers['accept']);
  if (opensChannel && (reqControlWord === undefined || reqControlWord === null)) {
    reqControlWord = 1;
  }
  if (reqControlWord !== undefined) {
    payload.controlWord = reqControlWord;
  }
  return { reqControlWord, opensChannel };
}

function resolveIntentDispatchFn(intent) {
  const isXAudioPlay = intent.startsWith('xaudio.Play') || intent === 'XAudioPlay' || intent === 'XAudioPlayV0';
  if (isXAudioPlay) return xintent.sendXAudioPlayV0 || xintent.sendXIntentIntentV0;
  const isXAudioControl = intent.startsWith('xaudio.Control') || intent === 'XAudioControl' || intent === 'XAudioControlV0';
  if (isXAudioControl) return xintent.sendXAudioControlV0 || xintent.sendXIntentIntentV0;
  return xintent.sendXIntentIntentV0;
}

function extractRawBlobRef(req, payload) {
  const reqDataBlobHeader = req.headers['x-attached-blob-id'] || req.headers['x-blob-id'];
  const rawRef = reqDataBlobHeader || payload.dataBlob || payload.sample || payload.blob || payload.blobId || payload.BlobId;
  delete payload.dataBlob;
  delete payload.blobId;
  delete payload.BlobId;
  return rawRef;
}

module.exports = {
  writeJsonFrame,
  writeXBlobFrame,
  createMessageFromXHandler,
  validateAndNormalizeIntentPayload,
  buildIntentLogPayload,
  applyRequestHeadersToPayload,
  parseChannelControlOptions,
  resolveIntentDispatchFn,
  extractRawBlobRef,
};
