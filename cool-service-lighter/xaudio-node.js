// matchbox-service-lighter/xaudio-node.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const xintent = require('../x11-promises/xintent');
const { Logger } = require('../server-tools');

const logger = new Logger({ module: 'xaudio-host' });

let X;
let lighterWin;
const prefetchedBlobs = new Map(); // blobId -> filePath
const activeProcesses = new Map();  // cookie -> ChildProcess
const playbackQueues = new Map();   // cookie -> { nextSeqnum, pending: Map(seqnum -> item), isPlaying: boolean }

function getAudioPlayerCmd() {
  return process.env.AUDIO_PLAYER_CMD || process.env.XAUDIO_PLAYER_CMD || 'ffplay';
}

function createWavHeader(dataLength, sampleRate = 22050, channels = 2, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return header;
}

function extractFdRightsPath(data) {
  const isFdRights = data._dataType === 'fd-rights' || data.contentEncoding === 'fd-rights';
  if (isFdRights && typeof data.data === 'string' && data.data.trim()) {
    return data.data.trim();
  }
  return null;
}

function convertObjectAudioDataToBuffer(obj) {
  if (Array.isArray(obj)) return Buffer.from(obj);
  if (Array.isArray(obj.data)) return Buffer.from(obj.data);
  return Buffer.from(JSON.stringify(obj), 'utf-8');
}

function decodeAudioBlobBuffer(data) {
  if (data._dataType === 'text') return Buffer.from(data.data, 'utf-8');
  if (data._dataType === 'base64') return Buffer.from(data.data, 'base64');
  if (!data.data) throw new Error('Invalid blob data format for audio playback');

  if (Buffer.isBuffer(data.data)) return data.data;
  if (typeof data.data === 'string') return Buffer.from(data.data, 'base64');
  if (typeof data.data === 'object') return convertObjectAudioDataToBuffer(data.data);
  return Buffer.from(String(data.data));
}

function ensureAudioContainerHeader(buf, data, payload) {
  const isMp3 = Boolean(data.type && data.type.includes('mp3'));
  if (isMp3 || buf.length < 4) return buf;
  const hasRiffOrId3 = buf.subarray(0, 4).equals(Buffer.from('RIFF')) || buf.subarray(0, 3).equals(Buffer.from('ID3'));
  if (hasRiffOrId3) return buf;

  const sampleRate = payload.sampleRate || payload.rate || 22050;
  const channels = payload.channels || 2;
  const bitsPerSample = payload.sampleBits || 16;
  const wavHeader = createWavHeader(buf.length, sampleRate, channels, bitsPerSample);
  return Buffer.concat([wavHeader, buf]);
}

async function resolveBlobToFilePath(blobId, payload = {}) {
  const numericBlobId = Number(blobId);
  if (prefetchedBlobs.has(numericBlobId)) {
    return prefetchedBlobs.get(numericBlobId);
  }

  const data = await xintent.XBlobRead(X, xintent.routerWin, numericBlobId);
  if (!data) {
    throw new Error(`XBlobRead returned null/empty for blobId ${numericBlobId}`);
  }

  const fdPath = extractFdRightsPath(data);
  if (fdPath) {
    prefetchedBlobs.set(numericBlobId, fdPath);
    return fdPath;
  }

  const rawBuf = decodeAudioBlobBuffer(data);
  const buf = ensureAudioContainerHeader(rawBuf, data, payload);

  const ext = data.type && data.type.includes('mp3') ? '.mp3' : '.wav';
  const filePath = path.join(os.tmpdir(), `xaudio_${numericBlobId}_${Date.now()}${ext}`);
  fs.writeFileSync(filePath, buf);
  prefetchedBlobs.set(numericBlobId, filePath);
  return filePath;
}

function collectKeysForChannel(channel) {
  const keys = new Set();
  for (const [k, q] of playbackQueues.entries()) {
    if (q.channel === channel) keys.add(k);
    for (const item of q.pending.values()) {
      if (item.channel === channel) keys.add(k);
    }
  }
  return keys;
}

function stopProcess(cookie, channel = 0) {
  const keysToStop = cookie ? new Set([cookie]) : new Set();
  if (channel > 0) {
    for (const k of collectKeysForChannel(channel)) keysToStop.add(k);
  }

  if (!playbackQueues.has(cookie) && !activeProcesses.has(cookie) && keysToStop.size <= 1) {
    for (const k of playbackQueues.keys()) keysToStop.add(k);
    for (const k of activeProcesses.keys()) keysToStop.add(k);
  }

  for (const k of keysToStop) {
    playbackQueues.delete(k);
    const proc = activeProcesses.get(k);
    if (proc) {
      try { proc.kill('SIGTERM'); } catch (_) {}
      activeProcesses.delete(k);
    }
  }
}

function dequeueNextPlayableItem(queue) {
  let item = queue.pending.get(queue.nextSeqnum);
  if (!item && queue.pending.size > 0) {
    const lowestAvailable = Array.from(queue.pending.keys()).sort((a, b) => a - b)[0];
    if (lowestAvailable > queue.nextSeqnum) {
      logger.warn(`[XAudioSink] Missing seqnum ${queue.nextSeqnum} in queue, skipping gap to seqnum ${lowestAvailable}`);
      queue.nextSeqnum = lowestAvailable;
      item = queue.pending.get(queue.nextSeqnum);
    }
  }
  if (item) {
    queue.pending.delete(queue.nextSeqnum);
  }
  return item;
}

function buildPlayerSpawnArgs(filePath, payload, isCustomCmd) {
  if (isCustomCmd) return [filePath];
  const args = ['-nodisp', '-autoexit'];
  if (payload.volume !== undefined && payload.volume !== null) {
    const volInt = Math.floor((Number(payload.volume) || 1.0) * 100);
    args.push('-volume', String(volInt));
  }
  if (payload.loop) {
    args.push('-loop', '0');
  }
  args.push(filePath);
  return args;
}

async function cleanupPlayedSampleBlob(blobId, numericBlobId) {
  try {
    await xintent.XBlobUnlink(X, xintent.routerWin, lighterWin, blobId);
    const cachedPath = prefetchedBlobs.get(numericBlobId);
    prefetchedBlobs.delete(numericBlobId);
    if (cachedPath && fs.existsSync(cachedPath)) {
      try { fs.unlinkSync(cachedPath); } catch (_) {}
    }
  } catch (err) {
    logger.warn(`Failed to unlink blob ${blobId} after playback:`, err.message);
  }
}

async function sendPlayResponseEvent({ senderWin, channel, controlWord, cookie, streamId, seqnum, status, message }) {
  if (!senderWin) return;
  try {
    const sendResponseFn = xintent.sendXAudioPlayResponseV0 || xintent.sendXIntentEventV0;
    await sendResponseFn(X, xintent.routerWin, {
      targetWin: senderWin,
      senderWin: lighterWin,
      channel: channel || 0,
      controlWord,
      payload: {
        event: 'XAudioPlayResponseV0',
        intent: 'XAudioPlayResponseV0',
        OutputId: cookie,
        cookie,
        streamId,
        seqnum,
        status,
        ...(message ? { message } : {}),
      },
    });
  } catch (err) {
    logger.warn(`Failed to send XAudioPlayResponse for cookie ${cookie} seq ${seqnum}:`, err.message);
  }
}

async function processQueue(cookie) {
  const queue = playbackQueues.get(cookie);
  if (!queue || queue.isPlaying) return;

  const item = dequeueNextPlayableItem(queue);
  if (!item) return;

  queue.isPlaying = true;
  const { blobId, payload, senderWin, channel } = item;
  const numericBlobId = Number(blobId);
  const seqnum = queue.nextSeqnum;
  const streamId = Number(payload.streamId ?? payload.stream ?? 1);

  try {
    const filePath = await resolveBlobToFilePath(blobId, payload);
    const player = getAudioPlayerCmd();
    const isCustomCmd = Boolean(process.env.AUDIO_PLAYER_CMD || process.env.XAUDIO_PLAYER_CMD);
    const args = buildPlayerSpawnArgs(filePath, payload, isCustomCmd);

    const proc = spawn(player, args, { shell: isCustomCmd, stdio: ['ignore', 'ignore', 'inherit'] });
    trackChild(proc);
    activeProcesses.set(cookie, proc);

    proc.on('close', async () => {
      activeProcesses.delete(cookie);
      await cleanupPlayedSampleBlob(blobId, numericBlobId);
      const responseControlWord = queue.pending.size === 0 ? 2 : 1;
      await sendPlayResponseEvent({ senderWin, channel, controlWord: responseControlWord, cookie, streamId, seqnum, status: 200 });
      queue.nextSeqnum++;
      queue.isPlaying = false;
      processQueue(cookie);
    });
  } catch (err) {
    logger.error(`Error playing sample ${blobId} for cookie ${cookie} seq ${seqnum}: ${err.message}`);
    queue.isPlaying = false;
    queue.nextSeqnum++;
    processQueue(cookie);
  }
}

function ensurePlaybackQueue(cookie, seqnum, channel) {
  if (!playbackQueues.has(cookie)) {
    playbackQueues.set(cookie, {
      nextSeqnum: seqnum !== null ? seqnum : 0,
      pending: new Map(),
      isPlaying: false,
      lastKeepAlive: false,
      channel,
    });
  }
  return playbackQueues.get(cookie);
}

async function playSoundBlob(payload, senderWin, dataBlob, channel = 0) {
  const reqOutputId = payload.OutputId || payload.outputId || payload.cookie || payload.Cookie;
  if (reqOutputId && reqOutputId !== defaultSinkName && reqOutputId !== 'default' && !playbackQueues.has(reqOutputId)) {
    logger.warn(`[XAudioSink] Warning: Received XAudioPlay for unrecognized OutputId '${reqOutputId}' (active sink is '${defaultSinkName}')`);
  }

  const cookie = reqOutputId || defaultSinkName;
  const rawBlob = dataBlob || payload.dataBlob || payload.sample || payload.BlobId || payload.blobId || payload.blob;
  const blobId = Number(rawBlob);
  const rawSeq = payload.seqnum ?? payload.seq;
  const seqnum = rawSeq !== undefined ? Number(rawSeq) : null;

  logger.setContext({ cookie, seqnum, blob: xintent.widString(blobId) });
  logger.info(`[XAudioSink] XAudioPlay: cookie=${cookie}, seqnum=${seqnum}, blob=${blobId}`);

  const queue = ensurePlaybackQueue(cookie, seqnum, channel);
  const reqHeaders = payload.headers || {};
  const connHeader = String(reqHeaders['Connection'] || reqHeaders['connection'] || payload.Connection || payload.connection || '').toLowerCase();
  queue.lastKeepAlive = connHeader === 'keep-alive' || payload.keepAlive === true;

  const targetSeqnum = seqnum !== null ? seqnum : (queue.pending.size + queue.nextSeqnum + (queue.isPlaying ? 1 : 0));
  if (targetSeqnum < queue.nextSeqnum) {
    logger.warn(`[XAudioSink] Outdated seqnum ${targetSeqnum} arrived after queue advanced to ${queue.nextSeqnum}, acknowledging 410 Too Late`);
    const streamId = payload.streamId !== undefined ? Number(payload.streamId) : 1;
    await sendPlayResponseEvent({ senderWin, channel, controlWord: 1, cookie, streamId, seqnum: targetSeqnum, status: 410, message: 'Too Late' });
    return { status: 'error', code: 410, message: 'Too Late', cookie, seqnum: targetSeqnum };
  }

  queue.pending.set(targetSeqnum, { blobId, payload, senderWin, channel });
  processQueue(cookie);
  return { status: 'ok', message: 'Enqueued for playback', cookie, seqnum: targetSeqnum };
}

async function prefetchSoundBlob(payload) {
  const blobId = payload.sample || payload.BlobId || payload.blobId || payload.blob;
  logger.info(`[XAudioSink] XAudioPrefetchSoundBlob: BlobId=${blobId}`);
  try {
    const filePath = await resolveBlobToFilePath(blobId);
    return { status: 'ok', filePath };
  } catch (err) {
    logger.error(`[XAudioSink] Error prefetching sound blob: ${err.message}`);
    return { status: 'error', message: err.message };
  }
}

async function playStream(payload, senderWin) {
  logger.info('[XAudioSink] XAudioPlayStream:', payload);
  return playSoundBlob(payload, senderWin);
}

async function controlStream(payload, channel = 0, controlWord = 0) {
  const { command, cookie, Cookie, OutputId, outputId, BlobId, streamId } = payload;
  const key = cookie || Cookie || OutputId || outputId || (streamId ? String(streamId) : null) || String(BlobId) || 'default';
  const reqControlWord = controlWord || payload.controlWord || 0;
  const isFin = (reqControlWord & 2) !== 0 ||
    String(payload.headers?.['x-channel-control'] || payload.headers?.['X-Channel-Control'] || '').includes('FIN');

  logger.info(`[XAudioSink] XAudioControlStream command=${command} for key=${key} (channel=${channel}, controlWord=${reqControlWord}, isFin=${isFin})`);

  if (command === 'stop' || command === 'pause' || isFin) {
    stopProcess(key, channel);
    return { status: 'ok', command: command || 'stop', isFin };
  }
  return { status: 'ok', command };
}

async function seekStream(payload) {
  const { seekTo } = payload;
  logger.info(`[XAudioSink] XAudioSeekStream to ${seekTo}`);
  return { status: 'ok', seekTo };
}

let trackChild = (proc) => proc;
let defaultSinkName = `${os.hostname()}-speakers`;

function init(g) {
  X = g.X;
  lighterWin = g.lighterWin;
  if (g.sinkName) defaultSinkName = g.sinkName;
  if (g.trackChild) trackChild = g.trackChild;
}

module.exports = {
  init,
  playSoundBlob,
  prefetchSoundBlob,
  playStream,
  controlStream,
  seekStream,
};
