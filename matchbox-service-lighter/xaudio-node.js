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
const prefetchedBlobs = new Map(); // blobAtom -> filePath
const activeProcesses = new Map();  // cookie -> ChildProcess
const playbackQueues = new Map();   // cookie -> { nextSeqnum, pending: Map(seqnum -> item), isPlaying: boolean }

function getAudioPlayerCmd() {
  return 'ffplay';
}

async function resolveBlobToFilePath(blobAtom) {
  if (prefetchedBlobs.has(blobAtom)) {
    return prefetchedBlobs.get(blobAtom);
  }

  const data = await xintent.XBlobRead(X, xintent.routerWin, blobAtom);
  let buf;
  if (data._dataType === 'text') {
    buf = Buffer.from(data.data, 'utf-8');
  } else if (data._dataType === 'base64') {
    buf = Buffer.from(data.data, 'base64');
  } else if (data.data) {
    buf = Buffer.from(data.data);
  } else {
    throw new Error('Invalid blob data format for audio playback');
  }

  const ext = data.type && data.type.includes('mp3') ? '.mp3' : '.wav';
  const fileId = `xaudio_${blobAtom}_${Date.now()}${ext}`;
  const filePath = path.join(os.tmpdir(), fileId);
  fs.writeFileSync(filePath, buf);
  prefetchedBlobs.set(blobAtom, filePath);
  return filePath;
}

function stopProcess(cookie) {
  if (playbackQueues.has(cookie)) {
    playbackQueues.delete(cookie);
  }
  if (activeProcesses.has(cookie)) {
    const proc = activeProcesses.get(cookie);
    try {
      proc.kill('SIGTERM');
    } catch (_) {}
    activeProcesses.delete(cookie);
  }
}

async function processQueue(cookie) {
  const queue = playbackQueues.get(cookie);
  if (!queue || queue.isPlaying) return;

  const item = queue.pending.get(queue.nextSeqnum);
  if (!item) return; // Wait for next sequential item

  queue.isPlaying = true;
  queue.pending.delete(queue.nextSeqnum);

  const { blobAtom, payload, senderWin } = item;
  const seqnum = queue.nextSeqnum;
  const streamId = payload.streamId !== undefined ? Number(payload.streamId) : (payload.stream !== undefined ? Number(payload.stream) : 1);

  try {
    const filePath = await resolveBlobToFilePath(blobAtom);
    const player = getAudioPlayerCmd();

    const args = ['-nodisp', '-autoexit'];
    if (payload.volume !== undefined && payload.volume !== null) {
      const volInt = Math.floor((Number(payload.volume) || 1.0) * 100);
      args.push('-volume', String(volInt));
    }
    if (payload.loop) {
      args.push('-loop', '0');
    }
    args.push(filePath);

    const proc = spawn(player, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    trackChild(proc);
    activeProcesses.set(cookie, proc);

    proc.on('close', async () => {
      activeProcesses.delete(cookie);

      // 1. Unlink sample XBlob when playback finishes
      try {
        await xintent.XBlobUnlink(X, xintent.routerWin, lighterWin, blobAtom);
        prefetchedBlobs.delete(blobAtom);
      } catch (err) {
        logger.warn(`Failed to unlink blob ${blobAtom} after playback:`, err.message);
      }

      // 2. Dispatch XAudioPlayResponseV0 event back to client with streamId and seqnum
      try {
        if (senderWin) {
          await xintent.sendXIntentEventV0(X, xintent.routerWin, {
            targetWin: senderWin,
            senderWin: lighterWin,
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
    logger.error(`Error playing sample ${blobAtom} for cookie ${cookie} seq ${seqnum}: ${err.message}`);
    queue.isPlaying = false;
    queue.nextSeqnum++;
    processQueue(cookie);
  }
}

async function playSoundBlob(payload, senderWin) {
  const cookie = payload.cookie || payload.Cookie || payload.OutputId || 'default';
  const blobAtom = payload.sample || payload.BlobId || payload.blobId || payload.blob;
  const seqnum = payload.seqnum !== undefined ? Number(payload.seqnum) : (payload.seq !== undefined ? Number(payload.seq) : null);

  logger.setContext({ cookie, seqnum, blob: xintent.widString(blobAtom) });
  logger.info(`[XAudioSink] XAudioPlay: cookie=${cookie}, seqnum=${seqnum}, blob=${blobAtom}`);

  if (!playbackQueues.has(cookie)) {
    playbackQueues.set(cookie, {
      nextSeqnum: seqnum !== null ? seqnum : 0,
      pending: new Map(),
      isPlaying: false
    });
  }

  const queue = playbackQueues.get(cookie);
  const targetSeqnum = seqnum !== null ? seqnum : (queue.pending.size + queue.nextSeqnum + (queue.isPlaying ? 1 : 0));

  queue.pending.set(targetSeqnum, {
    blobAtom,
    payload,
    senderWin,
  });

  processQueue(cookie);

  return { status: 'ok', message: 'Enqueued for playback', cookie, seqnum: targetSeqnum };
}

async function prefetchSoundBlob(payload) {
  const blobAtom = payload.sample || payload.BlobId || payload.blobId || payload.blob;
  logger.info(`[XAudioSink] XAudioPrefetchSoundBlob: BlobId=${blobAtom}`);
  try {
    const filePath = await resolveBlobToFilePath(blobAtom);
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

async function controlStream(payload) {
  const { command, cookie, Cookie, OutputId, outputId, BlobId, streamId } = payload;
  const key = cookie || Cookie || OutputId || outputId || (streamId ? String(streamId) : null) || String(BlobId) || 'default';
  logger.info(`[XAudioSink] XAudioControlStream command=${command} for key=${key}`);

  if (command === 'stop' || command === 'pause') {
    stopProcess(key);
    return { status: 'ok', command };
  }
  return { status: 'ok', command };
}

async function seekStream(payload) {
  const { seekTo, cookie, OutputId } = payload;
  logger.info(`[XAudioSink] XAudioSeekStream to ${seekTo}`);
  return { status: 'ok', seekTo };
}

let trackChild = proc => proc;

function init(g) {
  X = g.X;
  lighterWin = g.lighterWin;
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
