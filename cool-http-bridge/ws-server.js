const WebSocket = require('ws');
const xintent = require('../x11-promises/xintent');
const serverGlobals = require('./server-globals');

function formatMessageHttp(payload, blobData, txId, controlWord) {
  const jsonBody = JSON.stringify(payload, null, 2);
  const boundary = 'MatchboxFrameBoundary_' + Date.now().toString(16);

  if (!blobData) {
    const headers = [
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(jsonBody)}`,
      `X-Tx-Id: ${txId}`,
    ];
    if (controlWord !== undefined) {
      headers.push(`X-Channel-Control: ${controlWord & 2 ? 'FIN' : 'SYN'}`);
    }
    return headers.join('\r\n') + '\r\n\r\n' + jsonBody;
  }

  const mimeType = blobData.type || 'application/octet-stream';
  const rawData = blobData.data;
  const serialized = typeof rawData === 'object' ? JSON.stringify(rawData) : String(rawData || '');
  const bodyBuf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(serialized, 'utf8');

  const part1Header = `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(jsonBody)}\r\nX-Tx-Id: ${txId}`;
  const part2Header = `Content-Type: ${mimeType}\r\nContent-Length: ${bodyBuf.length}\r\nX-XBlob-Type: ${blobData.xblobType || 'Blob'}`;

  const headerBuf = Buffer.from(
    `Content-Type: multipart/mixed; boundary=${boundary}\r\n\r\n` +
    `--${boundary}\r\n${part1Header}\r\n\r\n${jsonBody}\r\n\r\n` +
    `--${boundary}\r\n${part2Header}\r\n\r\n`,
    'utf8'
  );
  const footerBuf = Buffer.from(`\r\n\r\n--${boundary}--\r\n`, 'utf8');

  return Buffer.concat([headerBuf, bodyBuf, footerBuf]);
}

function shouldFetchChannelBlob(msgPayload) {
  if (!msgPayload) return true;
  const flags = [
    msgPayload.receive_data,
    msgPayload.receiveData,
    msgPayload.fetch_data,
    msgPayload.fetch_blob,
    msgPayload.fetchData,
    msgPayload.fetchBlob,
  ];
  return !flags.includes(false);
}

async function readChannelBlob(X, root, logger, txId, dataBlob) {
  try {
    const routerWin = await xintent.getValidRouterWin(X, root);
    return await xintent.XBlobRead(X, routerWin, dataBlob);
  } catch (err) {
    logger.error(`Error reading dataBlob ${dataBlob} for WebSocket channel ${txId}: ${err.message}`);
    return null;
  }
}

function sendWsChannelFrame(ws, txId, msg, blobData) {
  if (ws.isMessageHttp || ws.protocol === 'message/http') {
    const httpMsg = formatMessageHttp(msg.payload || {}, blobData, txId, msg.controlWord);
    ws.send(httpMsg);
    return;
  }
  const responseFrame = {
    txId,
    controlWord: msg.controlWord,
    ...msg.payload,
    ...(blobData ? { blob: blobData } : {}),
  };
  ws.send(JSON.stringify(responseFrame));
}

function createWebSocketXChannel({ X, root, logger }, txId, ws, xaudioSink, msgPayload, controlWord) {
  const cardWin = serverGlobals.parseWindowId(msgPayload?.cardWin) || ws?.cardWin || ws?.proxyWin || 0;
  return {
    txId,
    cardWin,
    type: 'websocket',
    ws,
    xaudioSink: xaudioSink || ws?.xaudioSink || msgPayload?.app,
    intent: msgPayload?.intent,
    cookie: msgPayload?.cookie || msgPayload?.OutputId,
    controlWord: controlWord || 1,
    createdAt: Date.now(),
    messageFromX: async (msg) => {
      const fetchBlob = msg.dataBlob && shouldFetchChannelBlob(msgPayload);
      const blobData = fetchBlob ? await readChannelBlob(X, root, logger, txId, msg.dataBlob) : null;
      const widHex = cardWin ? xintent.widString(cardWin) : null;
      const cardRecord = widHex ? serverGlobals.cardWindows[widHex] : null;

      if (cardRecord) {
        cardRecord.bufferedFrames.push({ txId, msg, blobData });
        if (cardRecord.bufferedFrames.length > 50) cardRecord.bufferedFrames.shift();
      }

      const targets = new Set();
      if (ws && ws.readyState === WebSocket.OPEN) targets.add(ws);
      if (cardRecord?.wsSet) {
        for (const client of cardRecord.wsSet) {
          if (client.readyState === WebSocket.OPEN) targets.add(client);
        }
      }

      for (const targetWs of targets) {
        sendWsChannelFrame(targetWs, txId, msg, blobData);
      }
      if (targets.size > 0) {
        logger.info(`WebSocket XChannel ${txId} routed messageFromX: ${xintent.frameDesc(msg)}`);
      }

      const isFin = msg.controlWord !== undefined && (msg.controlWord & 2) !== 0;
      if (isFin) {
        logger.info(`Closing WebSocket XChannel ${txId} on FIN`);
        serverGlobals.deleteChannelSession(cardWin, txId);
        if (ws && ws.isXAudio) {
          try { ws.close(); } catch (_) {}
        }
      }
    },
  };
}

function parseIncomingWsData(data) {
  const dataStr = data.toString('utf8');
  if (dataStr.includes('Content-Type:') || dataStr.includes('MatchboxFrameBoundary')) {
    const parsedBlob = xintent.parseXBlobAtRest(data);
    return (parsedBlob && typeof parsedBlob.data === 'object') ? parsedBlob.data : parsedBlob;
  }
  return JSON.parse(dataStr);
}

function extractManifestSink(manifest, appName) {
  if (!manifest.includes('XAudioSink')) return null;
  const match = manifest.match(/\[XAudioSink\]\s*\n\s*name\s*=\s*"([^"]+)"/);
  return (match && match[1]) ? match[1] : appName;
}

async function ensureProxyWindow(X, root, logger, ws, appName) {
  if (ws.proxyWin) return ws.proxyWin;
  const existingRecord = serverGlobals.deviceProxyWindows[appName];
  if (existingRecord && existingRecord.wid) {
    ws.proxyWin = existingRecord.wid;
    logger.info(`Re-attached existing proxy X11 window ${xintent.widString(ws.proxyWin)} for '${appName}'`);
    return ws.proxyWin;
  }
  ws.proxyWin = await xintent.createClientWindow(X, root, appName);
  logger.info(`Allocated dedicated proxy X11 window ${xintent.widString(ws.proxyWin)} for '${appName}'`);
  return ws.proxyWin;
}

async function handleSysAdvertise({ X, root, logger }, ws, msg) {
  const appName = msg.app || 'flammenwerfer-phone';
  ws.appName = appName;
  if (ws.clientIp) {
    serverGlobals.lastKnownDeviceIps[appName] = ws.clientIp;
  }
  if (!msg.manifest) return;

  const detectedSink = extractManifestSink(msg.manifest, appName);
  if (detectedSink) ws.xaudioSink = detectedSink;
  if (ws.clientIp && ws.xaudioSink) {
    serverGlobals.lastKnownDeviceIps[ws.xaudioSink] = ws.clientIp;
  }

  await ensureProxyWindow(X, root, logger, ws, appName);
  const widHex = xintent.widString(ws.proxyWin);
  const deviceRecord = {
    wid: ws.proxyWin,
    widHex,
    appName,
    xaudioSink: ws.xaudioSink || appName,
    clientIp: ws.clientIp || null,
    updatedAt: Date.now(),
  };
  serverGlobals.deviceProxyWindows[appName] = deviceRecord;
  if (ws.xaudioSink) {
    serverGlobals.deviceProxyWindows[ws.xaudioSink] = deviceRecord;
  }
  serverGlobals.proxyWindowToDevice[widHex] = appName;

  await X.ChangeProperty(
    0,
    ws.proxyWin,
    xintent.atoms.MATCHBOX_TOML,
    xintent.atoms.STRING,
    8,
    Buffer.from(msg.manifest, 'utf8')
  );
  logger.info(`Registered MATCHBOX_TOML raw manifest on proxy window ${widHex} for '${appName}' (XAudioSink: ${ws.xaudioSink}):\n${msg.manifest}`);
}

function destroyWsProxyWindow(X, logger, ws, appName, reasonText) {
  const widHex = xintent.widString(ws.proxyWin);
  delete serverGlobals.proxyWindowToDevice[widHex];
  if (appName) delete serverGlobals.deviceProxyWindows[appName];
  if (ws.xaudioSink) delete serverGlobals.deviceProxyWindows[ws.xaudioSink];

  try {
    X.DestroyWindow(ws.proxyWin);
    logger.info(`Destroyed dedicated proxy X11 window ${widHex} ${reasonText}`);
  } catch (err) {
    logger.error(`Error destroying proxy window for '${appName}': ${err.message}`);
  }
  ws.proxyWin = null;
}

async function handleSysDeadvertise({ X, logger }, ws, msg) {
  const appName = msg.app || ws.appName || 'user-phone:flammenwerfer';
  logger.info(`Received sys.Deadvertise for '${appName}'`);
  ws.explicitDeadvertise = true;
  if (ws.proxyWin) {
    destroyWsProxyWindow(X, logger, ws, appName, `on sys.Deadvertise for '${appName}'`);
  }
}

async function handlePlayResponse({ X, root, clientWin }, ws, msg) {
  const txId = msg.txId || msg.channel;
  if (!txId) return;

  const routerWin = await xintent.getValidRouterWin(X, root);
  const sendResponseFn = xintent.sendXAudioPlayResponseV0 || xintent.sendXIntentEventV0;

  await sendResponseFn(X, routerWin, {
    senderWin: ws.proxyWin || clientWin,
    txId,
    controlWord: msg.controlWord || 1,
    payload: msg,
  });

  if ((msg.controlWord & 2) !== 0) {
    delete serverGlobals.channelNatTable[txId];
  }
}

function resolveWsIntentTxId(ctx, ws, msg, isXAudio, audioKey, senderWin) {
  ws.activeAudioTxIds = ws.activeAudioTxIds || {};
  let txId = msg.txId || (isXAudio ? ws.activeAudioTxIds[audioKey] : null);
  const existing = txId ? serverGlobals.getChannelSession(senderWin, txId) : null;
  if (!txId || !existing) {
    txId = txId || serverGlobals.getNextTxId();
    serverGlobals.advanceTxIdPast(txId);
    const session = createWebSocketXChannel(
      ctx,
      txId,
      ws,
      ws.xaudioSink || msg.app,
      msg,
      msg.controlWord || 1
    );
    serverGlobals.setChannelSession(senderWin, txId, session);
    if (isXAudio) {
      ws.activeAudioTxIds[audioKey] = txId;
    }
  }
  return txId;
}

async function handleWsIntent(ctx, ws, msg) {
  const { X, root, clientWin } = ctx;
  const routerWin = await xintent.getValidRouterWin(X, root);
  const isXAudio = msg.intent.startsWith('xaudio.') || msg.intent.startsWith('XAudio');
  const audioKey = msg.cookie || msg.OutputId || 'default';
  const senderWin = serverGlobals.parseWindowId(msg.cardWin) || ws.cardWin || ws.proxyWin || clientWin;
  const txId = resolveWsIntentTxId(ctx, ws, msg, isXAudio, audioKey, senderWin);
  msg.txId = txId;

  const dispatchFn = isXAudio
    ? (xintent.sendXAudioPlayV0 || xintent.sendXIntentIntentV0)
    : xintent.sendXIntentIntentV0;
  const reqDataBlob = msg.dataBlob || msg.sample || msg.blob || msg.blobId || msg.BlobId;

  await dispatchFn(X, routerWin, {
    senderWin,
    payload: msg,
    txId,
    controlWord: msg.controlWord || 1,
    dataBlob: reqDataBlob ? Number(reqDataBlob) : 0,
  });

  if (isXAudio && (msg.controlWord & 2) !== 0) {
    delete ws.activeAudioTxIds[audioKey];
  }
}

const WS_EVENT_HANDLERS = {
  'sys.Advertise': handleSysAdvertise,
  'sys.Deadvertise': handleSysDeadvertise,
  'XAudioPlayResponseV0': handlePlayResponse,
};

async function dispatchWsMessage(ctx, ws, data) {
  const { logger } = ctx;
  try {
    const msg = parseIncomingWsData(data);
    if (!ws.isXAudio) {
      logger.info('Remote WebSocket message received:', msg);
    }
    const eventOrIntent = msg.event || msg.intent;
    const handler = WS_EVENT_HANDLERS[eventOrIntent];
    if (handler) {
      await handler(ctx, ws, msg);
    } else if (msg.intent) {
      await handleWsIntent(ctx, ws, msg);
    }
  } catch (err) {
    logger.error('Remote WebSocket message error:', err.message);
  }
}

async function closeWsChannels({ X, root, clientWin, logger }, ws) {
  for (const [txIdStr, session] of Object.entries(serverGlobals.channelNatTable)) {
    if (session.ws !== ws) continue;
    const txId = Number(txIdStr);
    logger.info(`Closing XChannel ${txId} on WebSocket disconnect`);
    delete serverGlobals.channelNatTable[txId];

    try {
      const routerWin = await xintent.getValidRouterWin(X, root);
      if (routerWin) {
        await xintent.sendXIntentEventV0(X, routerWin, {
          targetWin: routerWin,
          senderWin: clientWin,
          txId,
          controlWord: 2,
          payload: {
            event: 'http.502',
            message: 'Connection reset by peer.',
            status: 502,
            controlWord: 2,
          },
        });
      }
    } catch (_) {}
  }
}

async function handleWsClose(ctx, ws) {
  const { X, logger, wsClients } = ctx;
  logger.info(`WebSocket client disconnected (XAudioSink: ${ws.xaudioSink || ws.appName || 'none'})`);
  wsClients.delete(ws);

  if (ws.proxyWin && ws.explicitDeadvertise) {
    const label = ws.appName || 'remote-device';
    destroyWsProxyWindow(X, logger, ws, ws.appName, `for '${label}' on explicit deadvertise`);
  } else if (ws.proxyWin) {
    logger.info(`Preserving proxy X11 window ${xintent.widString(ws.proxyWin)} for '${ws.appName || 'remote-device'}' during idle disconnect (available for UDP wake)`);
  }

  await closeWsChannels(ctx, ws);
}

function findMatchingWsClient(wsClients, targetSink) {
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN && (ws.xaudioSink === targetSink || ws.appName === targetSink)) {
      return ws;
    }
  }
  return null;
}

function pingInactiveSink(logger, targetSink) {
  const deviceName = targetSink.includes(':') ? targetSink.split(':')[0] : targetSink;
  const knownIpOrHost = serverGlobals.lastKnownDeviceIps[deviceName] || serverGlobals.lastKnownDeviceIps[targetSink];
  const isIpAddress = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(deviceName);
  const hostOrIp = knownIpOrHost || (isIpAddress ? deviceName : null);
  if (hostOrIp && hostOrIp !== 'localhost' && hostOrIp !== '127.0.0.1') {
    logger.info(`[UDP 🔔] Target WebSocket '${targetSink}' inactive. Sending UDP wake ping to ${hostOrIp}:12346...`);
    serverGlobals.sendUdpWakePing(hostOrIp, 12346);
  }
}

function resolveOrCreateXChannelSession(ctx, ev, parsed) {
  const { txId, controlWord, payload } = { txId: parsed.channel, ...parsed };
  const existing = serverGlobals.getChannelSession(ev.wid, txId);
  if (existing) return existing;

  const widHex = xintent.widString(ev.wid);
  const cardRecord = serverGlobals.cardWindows[widHex];
  if (cardRecord && cardRecord.ws && cardRecord.ws.readyState === WebSocket.OPEN) {
    const session = createWebSocketXChannel(ctx, txId, cardRecord.ws, cardRecord.appId, { ...payload, cardWin: ev.wid }, controlWord);
    serverGlobals.setChannelSession(ev.wid, txId, session);
    return session;
  }

  const isPlayOrIntent = ev.message_type === xintent.atoms.XAUDIO_PLAY_V0 || ev.message_type === xintent.atoms.XINTENT_INTENT_V0;
  if (!isPlayOrIntent) return null;

  const targetSink = payload.app || payload.XAudioSink || payload.sink || 'flammenwerfer-phone';
  const targetWs = findMatchingWsClient(ctx.wsClients, targetSink);
  if (targetWs) {
    const session = createWebSocketXChannel(ctx, txId, targetWs, targetSink, payload, controlWord);
    serverGlobals.setChannelSession(ev.wid, txId, session);
    return session;
  }
  pingInactiveSink(ctx.logger, targetSink);
  return null;
}

function forwardBlobEventToCardWs(ev, logger) {
  const widHex = xintent.widString(ev.wid);
  const cardRecord = serverGlobals.cardWindows[widHex];
  if (!cardRecord) return;

  let eventFrame = null;
  if (ev.message_type === xintent.atoms.XBLOB_BROADCAST_V0) {
    eventFrame = {
      event: 'XBLOB_BROADCAST_V0',
      senderWin: xintent.widString(ev.data[0]),
      blobId: xintent.widString(ev.data[1]),
      host: xintent.widString(ev.data[2]),
      version: ev.data[3],
      targetWin: widHex,
    };
  } else if (ev.message_type === xintent.atoms.XBLOB_STREAM_CLOSED_V0) {
    const low = (ev.data[3] || 0) >>> 0;
    const high = (ev.data[4] || 0) >>> 0;
    eventFrame = {
      event: 'XBLOB_STREAM_CLOSED_V0',
      senderWin: xintent.widString(ev.data[0]),
      blobId: xintent.widString(ev.data[1]),
      host: xintent.widString(ev.data[2]),
      size: high * 0x100000000 + low,
      targetWin: widHex,
    };
  }
  if (eventFrame) {
    cardRecord.bufferedBlobEvents.push(eventFrame);
    if (cardRecord.bufferedBlobEvents.length > 50) cardRecord.bufferedBlobEvents.shift();

    const targets = new Set();
    if (cardRecord.ws && cardRecord.ws.readyState === WebSocket.OPEN) targets.add(cardRecord.ws);
    if (cardRecord.wsSet) {
      for (const client of cardRecord.wsSet) {
        if (client.readyState === WebSocket.OPEN) targets.add(client);
      }
    }
    const serialized = JSON.stringify(eventFrame);
    for (const targetWs of targets) {
      try {
        targetWs.send(serialized);
      } catch (_) {}
    }
    if (targets.size > 0) {
      logger.info(`Forwarded ${eventFrame.event} for blob ${eventFrame.blobId} to card WebSocket (${widHex})`);
    }
  }
}

function setupX11EventDispatcher(ctx) {
  const { X, root, logger } = ctx;
  X.on('event', async (ev) => {
    if (!ev || ev.type !== 33) return;
    if (
      ev.message_type === xintent.atoms.XBLOB_BROADCAST_V0 ||
      ev.message_type === xintent.atoms.XBLOB_STREAM_CLOSED_V0
    ) {
      forwardBlobEventToCardWs(ev, logger);
      return;
    }

    const responseAtoms = [
      xintent.atoms.XINTENT_INTENT_V0,
      xintent.atoms.XINTENT_EVENT_V0,
      xintent.atoms.XAUDIO_PLAY_V0,
      xintent.atoms.XAUDIO_PLAY_RESPONSE_V0,
      xintent.atoms.XAUDIO_CONTROL_V0,
    ].filter(Boolean);
    if (!responseAtoms.includes(ev.message_type)) return;

    try {
      const routerWin = await xintent.getValidRouterWin(X, root);
      const parsed = await xintent.parseXIntentIntentV0(X, routerWin, ev);
      if (!parsed.channel) return;

      const session = resolveOrCreateXChannelSession(ctx, ev, parsed);
      if (session && typeof session.messageFromX === 'function') {
        await session.messageFromX(parsed);
      } else {
        logger.info(`Ignored packet on closed/inactive XChannel ${parsed.channel}: ${xintent.frameDesc(parsed)}`);
      }
    } catch (err) {
      logger.error(`Error in central X11 event dispatcher on clientWin: ${err.message}`);
    }
  });
}

function handleWsUpgrade(wss, ctx, request, socket, head) {
  const { logger } = ctx;
  const clientIp = (request?.socket?.remoteAddress || '').replace(/^.*:/, '');
  logger.info(`[WebSocket Upgrade] Incoming upgrade request from ${clientIp || 'unknown'} for URL: ${request.url} Headers: ${JSON.stringify(request?.headers || {})}`);

  if (request.headers && typeof request.headers['sec-websocket-protocol'] === 'string') {
    request.headers['sec-websocket-protocol'] = request.headers['sec-websocket-protocol'].replace(/message\/http/g, 'message-http');
  }

  try {
    const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost:12345'}`);
    const pathname = parsedUrl.pathname;
    if (pathname === '/ws' || pathname === '/remote-intents' || pathname === '/xaudio') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.xaudioSink = parsedUrl.searchParams.get('XAudioSink') || parsedUrl.searchParams.get('app');
        if (pathname === '/xaudio' || ws.xaudioSink) ws.isXAudio = true;

        const cardWinParam = parsedUrl.searchParams.get('cardWin');
        if (cardWinParam) {
          ws.cardWin = serverGlobals.parseWindowId(cardWinParam);
          serverGlobals.registerCardWindow(
            ws.cardWin,
            parsedUrl.searchParams.get('appId') || ws.xaudioSink || 'xhtml-card',
            parsedUrl.searchParams.get('cardId') || 'main',
            ws
          );
        }

        const reattachParam = parsedUrl.searchParams.get('reattachTxIds');
        if (reattachParam && ws.cardWin) {
          const txIds = reattachParam.split(',').map((s) => Number(s.trim())).filter((n) => !isNaN(n) && n > 0);
          for (const txId of txIds) {
            serverGlobals.advanceTxIdPast(txId);
            const session = createWebSocketXChannel(ctx, txId, ws, ws.xaudioSink, { cardWin: ws.cardWin }, 1);
            serverGlobals.setChannelSession(ws.cardWin, txId, session);
            logger.info(`Re-attached migrated XChannel txId=${txId} to card WebSocket ${xintent.widString(ws.cardWin)}`);
          }
        }

        wss.emit('connection', ws, request);
      });
    } else {
      logger.warn(`Rejected WebSocket upgrade for unknown path: ${pathname} from ${clientIp}`);
      if (socket.writable) socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\nPath not found');
      socket.destroy();
    }
  } catch (err) {
    logger.error(`Error during WebSocket upgrade from ${clientIp}: ${err.message}`);
    socket.destroy();
  }
}

function setupWebSocketServer(server, ctx) {
  const { logger, wsClients } = ctx;
  setupX11EventDispatcher(ctx);

  const wss = new WebSocket.Server({
    noServer: true,
    handleProtocols: (protocols, req) => {
      const list = protocols ? (Array.isArray(protocols) ? protocols : Array.from(protocols)) : [];
      logger.info(`[handleProtocols] Negotiating subprotocols for ${req?.url}: ${JSON.stringify(list)}`);
      for (const p of list) {
        if (typeof p === 'string' && (p.trim() === 'message-http' || p.trim() === 'message/http')) return p;
      }
      return list[0] || false;
    },
  });

  wss.on('wsClientError', (err, socket, request) => {
    const url = request?.url || 'unknown';
    const clientIp = request?.socket?.remoteAddress ? request.socket.remoteAddress.replace(/^.*:/, '') : 'unknown';
    const errMsg = err?.message || 'WebSocket upgrade failed';
    logger.warn(`[WebSocket 400] Rejected upgrade request from ${clientIp} on ${url}: ${errMsg} Headers: ${JSON.stringify(request?.headers || {})}`);

    if (socket.writable) {
      const body = String(errMsg);
      const response = `HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      try { socket.write(response); } catch (_) {}
    }
    try { socket.destroy(); } catch (_) {}
  });

  wss.on('connection', (ws, request) => {
    const clientIp = request?.socket?.remoteAddress ? request.socket.remoteAddress.replace(/^.*:/, '') : null;
    if (clientIp) {
      ws.clientIp = clientIp;
      if (ws.xaudioSink) serverGlobals.lastKnownDeviceIps[ws.xaudioSink] = clientIp;
    }
    const logPrefix = (ws.isXAudio || ws.xaudioSink)
      ? `Remote XAudio WebSocket client connected (XAudioSink: ${ws.xaudioSink || 'default'}, IP: ${clientIp || 'unknown'})`
      : `Remote WebSocket client connected (IP: ${clientIp || 'unknown'})`;
    logger.info(logPrefix);
    wsClients.add(ws);

    if (ws.cardWin) {
      const widHex = xintent.widString(ws.cardWin);
      const cardRecord = serverGlobals.cardWindows[widHex];
      if (cardRecord) {
        for (const item of cardRecord.bufferedFrames || []) {
          try {
            sendWsChannelFrame(ws, item.txId, item.msg, item.blobData);
          } catch (_) {}
        }
        for (const evFrame of cardRecord.bufferedBlobEvents || []) {
          try {
            ws.send(JSON.stringify(evFrame));
          } catch (_) {}
        }
      }
    }

    ws.on('message', (data) => dispatchWsMessage(ctx, ws, data));
    ws.on('close', () => handleWsClose(ctx, ws));
  });

  server.on('upgrade', (request, socket, head) => handleWsUpgrade(wss, ctx, request, socket, head));

  return wss;
}

module.exports = {
  formatMessageHttp,
  createWebSocketXChannel,
  setupWebSocketServer,
};
