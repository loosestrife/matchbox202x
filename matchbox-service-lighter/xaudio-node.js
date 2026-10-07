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
const activeProcesses = new Map();  // outputKey -> ChildProcess

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

function stopProcess(key) {
  if (activeProcesses.has(key)) {
    const proc = activeProcesses.get(key);
    try {
      proc.kill('SIGTERM');
    } catch (_) {}
    activeProcesses.delete(key);
  }
}

async function playSoundBlob(payload) {
  const { BlobId, OutputId, volume, loop } = payload;
  const blobAtom = BlobId || payload.blobId || payload.blob;
  logger.info(`[XAudioSink] XAudioPlaySoundBlob: BlobId=${blobAtom}, volume=${volume}, loop=${loop}`);

  try {
    const filePath = await resolveBlobToFilePath(blobAtom);
    const player = getAudioPlayerCmd();

    const args = ['-nodisp', '-autoexit'];
    if (volume !== undefined && volume !== null) {
      const volInt = Math.floor((Number(volume) || 1.0) * 100);
      args.push('-volume', String(volInt));
    }
    if (loop) {
      args.push('-loop', '0');
    }
    args.push(filePath);

    const key = OutputId || String(blobAtom);
    stopProcess(key);

    const proc = spawn(player, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    trackChild(proc);
    activeProcesses.set(key, proc);

    proc.on('close', () => {
      if (activeProcesses.get(key) === proc) {
        activeProcesses.delete(key);
      }
    });

    return { status: 'ok', message: 'Playback started', key };
  } catch (err) {
    logger.error(`[XAudioSink] Error playing sound blob: ${err.message}`);
    return { status: 'error', message: err.message };
  }
}

async function prefetchSoundBlob(payload) {
  const blobAtom = payload.BlobId || payload.blobId || payload.blob;
  logger.info(`[XAudioSink] XAudioPrefetchSoundBlob: BlobId=${blobAtom}`);
  try {
    const filePath = await resolveBlobToFilePath(blobAtom);
    return { status: 'ok', filePath };
  } catch (err) {
    logger.error(`[XAudioSink] Error prefetching sound blob: ${err.message}`);
    return { status: 'error', message: err.message };
  }
}

async function playStream(payload) {
  logger.info(`[XAudioSink] XAudioPlayStream:`, payload);
  return playSoundBlob(payload);
}

async function controlStream(payload) {
  const { command, OutputId, outputId, BlobId } = payload;
  const key = OutputId || outputId || String(BlobId);
  logger.info(`[XAudioSink] XAudioControlStream command=${command} for key=${key}`);

  if (command === 'stop' || command === 'pause') {
    stopProcess(key);
    return { status: 'ok', command };
  }
  return { status: 'ok', command };
}

async function seekStream(payload) {
  const { seekTo, OutputId, outputId } = payload;
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
