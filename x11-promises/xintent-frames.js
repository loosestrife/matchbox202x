const x11 = require('./x11-promises');

const SYN = 1;
const FIN = 2;
const SYN_FIN = 3;

const widString = (wid) => '0x' + wid.toString(16);

let frameCtx = {
  atoms: {},
  getLogger: () => console,
  XBlobCreate: async () => 0,
  XBlobTransfer: async () => {},
  XBlobGrant: async () => {},
  XBlobRead: async () => null,
  XBlobUnlink: async () => {},
};

function setFrameContext(ctx) {
  frameCtx = Object.assign(frameCtx, ctx);
}

function buildClientMessageBuffer(targetWin, message_type, data) {
  const ev = Buffer.alloc(32);
  ev.writeInt8(33, 0); // ClientMessage
  ev.writeInt8(32, 1); // 32-bit format
  ev.writeUInt32LE((targetWin || 0) >>> 0, 4);
  ev.writeUInt32LE((message_type || 0) >>> 0, 8);
  for (let i = 0; i < data.length && i < 5; i++) {
    ev.writeUInt32LE((data[i] || 0) >>> 0, 12 + 4 * i);
  }
  return ev;
}

async function XClientMessage(X, targetWin, message_type, data) {
  const ev = buildClientMessageBuffer(targetWin, message_type, data);
  return X.SendEvent(targetWin, false, x11.eventMask.NoEventMask, ev);
}

function wrapPayloadIfNeeded(payload) {
  if (typeof payload === 'object' && payload !== null && payload.data === undefined && payload.xblobType === undefined) {
    return { xblobType: 'Blob', type: 'application/json', data: payload };
  }
  return payload;
}

async function shareFrameBlobs(X, routerWin, senderWin, targetWin, payloadBlob, dataBlob, unlinkPayloadBlob) {
  if (targetWin === senderWin) return;
  const shareFn = unlinkPayloadBlob ? frameCtx.XBlobTransfer : frameCtx.XBlobGrant;
  await shareFn(X, routerWin, senderWin, payloadBlob, targetWin);
  if (dataBlob) {
    await shareFn(X, routerWin, senderWin, dataBlob, targetWin);
  }
}

function validateAndResolveChannel(txId, channel, logger) {
  if (txId !== undefined && txId > 16777215) {
    logger.error('txId above 16777216', { txId, channel });
  }
  if (channel !== undefined && (channel != 0 && channel < 16777216)) {
    logger.error('channel under 16777216', { txId, channel });
  }
  if (txId !== undefined && channel !== undefined) {
    logger.error('only allowed to specify one of txId, channel', { txId, channel });
  }
  if (channel !== undefined && channel !== 0) return channel >>> 0;
  if (txId !== undefined) return txId >>> 0;
  return 0;
}

async function sendXChannelJsonFrame(
  messageTypeAtom,
  X,
  routerWin,
  { targetWin, senderWin, txId, channel, controlWord, payload, payloadBlob, dataBlob, unlinkPayloadBlob = true }
) {
  const logger = frameCtx.getLogger();
  const resolvedTarget = targetWin || routerWin;
  const resolvedPayloadBlob = payloadBlob || (await frameCtx.XBlobCreate(X, routerWin, senderWin, wrapPayloadIfNeeded(payload)));

  await shareFrameBlobs(X, routerWin, senderWin, resolvedTarget, resolvedPayloadBlob, dataBlob, unlinkPayloadBlob);

  const channelToSend = validateAndResolveChannel(txId, channel, logger);
  const ctrlWordToSend = (controlWord !== undefined ? controlWord : 0) >>> 0;

  await XClientMessage(X, resolvedTarget, messageTypeAtom, [
    (senderWin || routerWin) >>> 0,
    channelToSend,
    ctrlWordToSend,
    resolvedPayloadBlob >>> 0,
    (dataBlob || 0) >>> 0,
  ]);

  logger.info(
    `Dispatched XChannelJsonFrame (atom ${messageTypeAtom}) to ${widString(resolvedTarget)} (channel ${channelToSend}, ctrl ${ctrlWordToSend}, payload blob ${widString(resolvedPayloadBlob)}${dataBlob ? `, data blob ${widString(dataBlob)}` : ''})`
  );
  return resolvedPayloadBlob;
}

const sendXIntentIntentV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(frameCtx.atoms.XINTENT_INTENT_V0, X, routerWin, opts);

const sendXIntentEventV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(frameCtx.atoms.XINTENT_EVENT_V0, X, routerWin, opts);

const sendXAudioPlayV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(frameCtx.atoms.XAUDIO_PLAY_V0, X, routerWin, opts);

const sendXAudioPlayResponseV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(frameCtx.atoms.XAUDIO_PLAY_RESPONSE_V0, X, routerWin, opts);

const sendXAudioControlV0 = (X, routerWin, opts) =>
  sendXChannelJsonFrame(frameCtx.atoms.XAUDIO_CONTROL_V0, X, routerWin, opts);

function unwrapBlobPayload(rawBlob) {
  let payload = (rawBlob && typeof rawBlob === 'object' && rawBlob.data !== undefined)
    ? rawBlob.data
    : rawBlob;
  if (
    payload &&
    typeof payload === 'object' &&
    !payload.intent &&
    !payload.event &&
    !payload.action &&
    payload.data !== undefined &&
    typeof payload.data === 'object'
  ) {
    payload = payload.data;
  }
  return payload;
}

function updateCommandContext(logger, payload) {
  if (!payload || typeof payload !== 'object') return;
  const cmd = payload.intent || payload.event || payload.action;
  if (cmd) {
    logger.setContext({ command: cmd });
  }
}

async function parseJsonFrame(X, routerWin, ev, { unlinkPayloadBlob = true } = {}) {
  const logger = frameCtx.getLogger();
  const senderWin = ev.data[0];
  const payloadBlob = ev.data[3] || ev.data[1];
  logger.setContext({
    sender: widString(senderWin),
    payloadBlob: widString(payloadBlob),
  });
  const rawBlob = await frameCtx.XBlobRead(X, routerWin, payloadBlob);
  const headers = rawBlob?.headers || {};
  const payload = unwrapBlobPayload(rawBlob);
  updateCommandContext(logger, payload);
  if (unlinkPayloadBlob) {
    frameCtx.XBlobUnlink(X, routerWin, ev.wid, payloadBlob);
  }
  return { targetWin: ev.wid, senderWin, payload, payloadBlob, headers };
}

async function parseXIntentIntentV0(X, routerWin, ev, { unlinkPayloadBlob = true } = {}) {
  const { senderWin, payload, payloadBlob, headers } = await parseJsonFrame(
    X,
    routerWin,
    ev,
    { unlinkPayloadBlob }
  );
  return {
    targetWin: ev.wid,
    senderWin,
    channel: ev.data[1],
    controlWord: ev.data[2],
    payload,
    payloadBlob,
    dataBlob: ev.data[4],
    messageTypeAtom: ev.message_type,
    headers,
  };
}

function parseXBlobBroadcastFrame(X, routerWin, ev) {
  return {
    blob: ev.data[1],
    host: ev.data[2],
    version: ev.data[3],
  };
}

function parseXBlobDestructorFrame(X, routerWin, ev) {
  return {
    blob: ev.data[1],
  };
}

function getAtomName(atomId) {
  if (typeof atomId === 'string' && atomId.length > 0) return atomId;
  if (typeof atomId === 'number') {
    for (const [name, val] of Object.entries(frameCtx.atoms)) {
      if (val === atomId) return name;
    }
    return `ATOM_${atomId}`;
  }
  return 'FRAME';
}

function extractMsgAtomId(msg) {
  return msg.messageTypeAtom || msg.message_type || msg.messageType || msg.type || msg.atom;
}

function extractActionName(payload) {
  if (!payload || typeof payload !== 'object') return undefined;
  const direct = payload.intent || payload.event || payload.action;
  if (direct) return direct;
  if (payload.data && typeof payload.data === 'object') {
    return payload.data.intent || payload.data.event || payload.data.action;
  }
  return undefined;
}

function frameType(msg) {
  if (!msg) return 'UNKNOWN_FRAME';
  const atomName = getAtomName(extractMsgAtomId(msg));
  const payload = msg.payload || (typeof msg === 'object' ? msg : {});
  const actionName = extractActionName(payload);
  return actionName ? `${atomName}:${actionName}` : atomName;
}

function formatControlWord(cw) {
  if (cw === undefined || cw === null) return '';
  const num = Number(cw);
  const flags = [];
  if (num & 1) flags.push('SYN');
  if (num & 2) flags.push('FIN');
  return flags.length > 0 ? flags.join(',') : String(num);
}

function formatFrameCtrlPrefix(channel, cw) {
  const hasChannel = channel !== undefined && channel !== 0;
  if (cw === undefined && !hasChannel) return '';
  const channelPart = hasChannel ? `${channel}:` : '';
  const cwPart = cw !== undefined ? formatControlWord(cw) : '';
  return `[${channelPart}${cwPart}]`;
}

function frameDesc(msg) {
  if (!msg) return 'UNKNOWN_FRAME';
  const sender = msg.senderWin || msg.sender || 0;
  const target = msg.targetWin || msg.target || msg.wid || 0;
  const cw = msg.controlWord !== undefined ? msg.controlWord : msg.ctrl;
  const channel = msg.channel !== undefined ? msg.channel : msg.txId;
  const ctrlStr = formatFrameCtrlPrefix(channel, cw);
  return `${widString(sender)} - ${ctrlStr}${frameType(msg)} -> ${widString(target)}`;
}

module.exports = {
  SYN,
  FIN,
  SYN_FIN,
  widString,
  setFrameContext,
  buildClientMessageBuffer,
  XClientMessage,
  sendXChannelJsonFrame,
  sendXIntentIntentV0,
  sendXIntentEventV0,
  sendXAudioPlayV0,
  sendXAudioPlayResponseV0,
  sendXAudioControlV0,
  parseJsonFrame,
  parseXIntentIntentV0,
  parseXBlobBroadcastFrame,
  parseXBlobDestructorFrame,
  getAtomName,
  frameType,
  formatControlWord,
  frameDesc,
};
