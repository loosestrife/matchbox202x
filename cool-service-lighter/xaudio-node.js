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

async function resolveBlobToFilePath(blobId, payload = {}) {
  const numericBlobId = Number(blobId);
  if (prefetchedBlobs.has(numericBlobId)) {
    return prefetchedBlobs.get(numericBlobId);
  }

  const data = await xintent.XBlobRead(X, xintent.routerWin, numericBlobId);
  if (!data) {
    throw new Error(`XBlobRead returned null/empty for blobId ${numericBlobId}`);
  }

  // 1. If blob is fd-rights or a direct file descriptor/path, return path directly
  if (data._dataType === 'fd-rights' || data.contentEncoding === 'fd-rights') {
    if (typeof data.data === 'string' && data.data.trim()) {
      const fdPath = data.data.trim();
      prefetchedBlobs.set(numericBlobId, fdPath);
      return fdPath;
    }
  }
  let buf;
  if (data._dataType === 'text') {
    buf = Buffer.from(data.data, 'utf-8');
  } else if (data._dataType === 'base64') {
    buf = Buffer.from(data.data, 'base64');
  } else if (data.data) {
    if (Buffer.isBuffer(data.data)) {
      buf = data.data;
    } else if (typeof data.data === 'string') {
      buf = Buffer.from(data.data, 'base64');
    } else if (typeof data.data === 'object') {
      if (Array.isArray(data.data)) {
        buf = Buffer.from(data.data);
      } else if (Array.isArray(data.data.data)) {
        buf = Buffer.from(data.data.data);
      } else {
        buf = Buffer.from(JSON.stringify(data.data), 'utf-8');
      }
    } else {
      buf = Buffer.from(String(data.data));
    }
  } else {
    throw new Error('Invalid blob data format for audio playback');
  }

  /* Prepend WAV header if raw PCM is received */
  if (buf.length >= 4 && !buf.subarray(0, 4).equals(Buffer.from('RIFF')) && !buf.subarray(0, 3).equals(Buffer.from('ID3'))) {
    const isMp3 = data.type && data.type.includes('mp3');
    if (!isMp3) {
      const sampleRate = payload.sampleRate || payload.rate || 22050;
      const channels = payload.channels || 2;
      const bitsPerSample = payload.sampleBits || 16;
      const wavHeader = createWavHeader(buf.length, sampleRate, channels, bitsPerSample);
      buf = Buffer.concat([wavHeader, buf]);
    }
  }

  const ext = data.type && data.type.includes('mp3') ? '.mp3' : '.wav';
  const fileId = `xaudio_${numericBlobId}_${Date.now()}${ext}`;
  const filePath = path.join(os.tmpdir(), fileId);
  fs.writeFileSync(filePath, buf);
  prefetchedBlobs.set(numericBlobId, filePath);
  return filePath;
}

function stopProcess(cookie, channel = 0) {
  const keysToStop = new Set();
  if (cookie) keysToStop.add(cookie);

  if (channel > 0) {
    for (const [k, q] of playbackQueues.entries()) {
      if (q.channel === channel) keysToStop.add(k);
      for (const item of q.pending.values()) {
        if (item.channel === channel) keysToStop.add(k);
      }
    }
  }

  if (!playbackQueues.has(cookie) && !activeProcesses.has(cookie) && keysToStop.size <= 1) {
    for (const k of playbackQueues.keys()) keysToStop.add(k);
    for (const k of activeProcesses.keys()) keysToStop.add(k);
  }

  for (const k of keysToStop) {
    playbackQueues.delete(k);
    if (activeProcesses.has(k)) {
      const proc = activeProcesses.get(k);
      try {
        proc.kill('SIGTERM');
      } catch (_) {}
      activeProcesses.delete(k);
    }
  }
}

async function processQueue(cookie) {
  const queue = playbackQueues.get(cookie);
  if (!queue || queue.isPlaying) return;

  let item = queue.pending.get(queue.nextSeqnum);
  if (!item) {
    if (queue.pending.size > 0) {
      const availableSeqnums = Array.from(queue.pending.keys()).sort((a, b) => a - b);
      const lowestAvailable = availableSeqnums[0];
      if (lowestAvailable > queue.nextSeqnum) {
        logger.warn(`[XAudioSink] Missing seqnum ${queue.nextSeqnum} in queue, skipping gap to seqnum ${lowestAvailable}`);
        queue.nextSeqnum = lowestAvailable;
        item = queue.pending.get(queue.nextSeqnum);
      }
    }
  }

  if (!item) return; // Wait strictly for next sequential item to arrive

  queue.isPlaying = true;
  queue.pending.delete(queue.nextSeqnum);

  const { blobId, payload, senderWin, channel } = item;
  const numericBlobId = Number(blobId);
  const seqnum = queue.nextSeqnum;
  const streamId = payload.streamId !== undefined ? Number(payload.streamId) : (payload.stream !== undefined ? Number(payload.stream) : 1);

  try {
    const filePath = await resolveBlobToFilePath(blobId, payload);
    const player = getAudioPlayerCmd();

    const isCustomCmd = Boolean(process.env.AUDIO_PLAYER_CMD || process.env.XAUDIO_PLAYER_CMD);
    const args = isCustomCmd ? [filePath] : ['-nodisp', '-autoexit'];
    if (!isCustomCmd) {
      if (payload.volume !== undefined && payload.volume !== null) {
        const volInt = Math.floor((Number(payload.volume) || 1.0) * 100);
        args.push('-volume', String(volInt));
      }
      if (payload.loop) {
        args.push('-loop', '0');
      }
      args.push(filePath);
    }

    const proc = spawn(player, args, { shell: isCustomCmd, stdio: ['ignore', 'ignore', 'inherit'] });
    trackChild(proc);
    activeProcesses.set(cookie, proc);

    proc.on('close', async () => {
      activeProcesses.delete(cookie);

      // 1. Unlink sample XBlob when playback finishes
      try {
        await xintent.XBlobUnlink(X, xintent.routerWin, lighterWin, blobId);
        const filePath = prefetchedBlobs.get(numericBlobId);
        prefetchedBlobs.delete(numericBlobId);
        if (filePath && fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (_) {}
        }
      } catch (err) {
        logger.warn(`Failed to unlink blob ${blobId} after playback:`, err.message);
      }

      // 2. Dispatch XAudioPlayResponseV0 event back to client with streamId and seqnum
      try {
        if (senderWin) {
          const sendResponseFn = xintent.sendXAudioPlayResponseV0 || xintent.sendXIntentEventV0;
          const isQueueEmpty = queue.pending.size === 0;
          const responseControlWord = isQueueEmpty ? 2 : 1; // 2 = FIN if queue empty
          await sendResponseFn(X, xintent.routerWin, {
            targetWin: senderWin,
            senderWin: lighterWin,
            channel: channel || 0,
            controlWord: responseControlWord,
            payload: {
              event: 'XAudioPlayResponseV0',
              intent: 'XAudioPlayResponseV0',
              OutputId: cookie,
              cookie: cookie,
              streamId: streamId,
              seqnum: seqnum,
              status: 200
            }
          });
        }
      } catch (err) {
        logger.warn(`Failed to send XAudioPlayResponse for cookie ${cookie} seq ${seqnum}:`, err.message);
      }

      // Advance sequence and process next queued item
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

async function playSoundBlob(payload, senderWin, dataBlob, channel = 0) {
  const reqOutputId = payload.OutputId || payload.outputId || payload.cookie || payload.Cookie;
  if (reqOutputId && reqOutputId !== defaultSinkName && reqOutputId !== 'default' && !playbackQueues.has(reqOutputId)) {
    logger.warn(`[XAudioSink] Warning: Received XAudioPlay for unrecognized OutputId '${reqOutputId}' (active sink is '${defaultSinkName}')`);
  }

  const cookie = reqOutputId || defaultSinkName;
  const rawBlob = dataBlob || payload.dataBlob || payload.sample || payload.BlobId || payload.blobId || payload.blob;
  const blobId = Number(rawBlob);
  const seqnum = payload.seqnum !== undefined ? Number(payload.seqnum) : (payload.seq !== undefined ? Number(payload.seq) : null);

  logger.setContext({ cookie, seqnum, blob: xintent.widString(blobId) });
  logger.info(`[XAudioSink] XAudioPlay: cookie=${cookie}, seqnum=${seqnum}, blob=${blobId}`);

  if (!playbackQueues.has(cookie)) {
    playbackQueues.set(cookie, {
      nextSeqnum: seqnum !== null ? seqnum : 0,
      pending: new Map(),
      isPlaying: false,
      lastKeepAlive: false,
      channel: channel
    });
  }

  const reqHeaders = payload.headers || {};
  const connHeader = (reqHeaders['Connection'] || reqHeaders['connection'] || payload.Connection || payload.connection || '').toLowerCase();
  const isKeepAlive = connHeader === 'keep-alive' || payload.keepAlive === true;

  const queue = playbackQueues.get(cookie);
  queue.lastKeepAlive = isKeepAlive;
  const targetSeqnum = seqnum !== null ? seqnum : (queue.pending.size + queue.nextSeqnum + (queue.isPlaying ? 1 : 0));

  if (targetSeqnum < queue.nextSeqnum) {
    logger.warn(`[XAudioSink] Outdated seqnum ${targetSeqnum} arrived after queue advanced to ${queue.nextSeqnum}, acknowledging 410 Too Late`);
    if (senderWin) {
      const sendResponseFn = xintent.sendXAudioPlayResponseV0 || xintent.sendXIntentEventV0;
      await sendResponseFn(X, xintent.routerWin, {
        targetWin: senderWin,
        senderWin: lighterWin,
        channel: channel || 0,
        controlWord: 1,
        payload: {
          event: 'XAudioPlayResponseV0',
          intent: 'XAudioPlayResponseV0',
          OutputId: cookie,
          cookie: cookie,
          streamId: payload.streamId !== undefined ? Number(payload.streamId) : 1,
          seqnum: targetSeqnum,
          status: 410,
          message: 'Too Late'
        }
      });
    }
    return { status: 'error', code: 410, message: 'Too Late', cookie, seqnum: targetSeqnum };
  }

  queue.pending.set(targetSeqnum, {
    blobId,
    payload,
    senderWin,
    channel,
  });

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
  logger.info(`[XAudioSink] XAudioPlayStream:`, payload);
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
  const { seekTo, cookie, OutputId } = payload;
  logger.info(`[XAudioSink] XAudioSeekStream to ${seekTo}`);
  return { status: 'ok', seekTo };
}

let trackChild = proc => proc;

let defaultSinkName = `${os.hostname()}-speakers`;

function init(g) {
  X = g.X;
  lighterWin = g.lighterWin;
  if (g.sinkName) {
    defaultSinkName = g.sinkName;
  }
  if (g.trackChild) {
    trackChild = g.trackChild;
  }
}

module.exports = {
  init,
  playSoundBlob,
  prefetchSoundBlob,
  playStream,
  controlStream,
  seekStream,
};
