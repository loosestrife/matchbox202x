// Debug telemetry, metrics counters, and inspection object for cool-ebooks

let totalWordsSent = 0;
let totalBytesReceived = 0;
let pendingTtsCount = 0;
let bufferedPlayCount = 0;

function updatePipelineCounters(pendingDelta, bufferedDelta) {
  pendingTtsCount = Math.max(0, pendingTtsCount + pendingDelta);
  bufferedPlayCount = Math.max(0, bufferedPlayCount + bufferedDelta);

  const pendingEl = document.getElementById('debug-pending-tts');
  const bufferedEl = document.getElementById('debug-buffered-play');
  if (pendingEl) pendingEl.textContent = pendingTtsCount;
  if (bufferedEl) bufferedEl.textContent = bufferedPlayCount;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function logDebug(msg) {
  const debugLogEl = document.getElementById('debug-log');
  if (!debugLogEl) return;
  const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
  const line = `[${timeStr}] ${msg}\n`;
  debugLogEl.textContent += line;
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

function updateDebugMetrics(words, bytes, rttMs) {
  totalWordsSent += words;
  totalBytesReceived += bytes;

  const wordsEl = document.getElementById('debug-words');
  const bytesEl = document.getElementById('debug-bytes');
  const rttEl = document.getElementById('debug-rtt');

  if (wordsEl) wordsEl.textContent = totalWordsSent.toLocaleString();
  if (bytesEl) bytesEl.textContent = formatBytes(totalBytesReceived);
  if (rttEl) rttEl.textContent = `${rttMs} ms`;
}

function updateTtsStatus(msg) {
  const ttsStatusEl = document.getElementById('tts-status');
  if (ttsStatusEl) {
    ttsStatusEl.textContent = msg;
  }
}

// Global inspection object for cool-ebooks debugging
window.coolEbooks = {
  getReceivedStreamFrames: () => (typeof receivedStreamFrames !== 'undefined' ? receivedStreamFrames : []),
  getPendingResolvers: () => (typeof chunkPlaybackResolvers !== 'undefined' ? Array.from(chunkPlaybackResolvers.keys()) : []),
  getTtsQueue: () => (typeof ttsQueue !== 'undefined' ? ttsQueue : []),
  getTtsIndex: () => (typeof ttsIndex !== 'undefined' ? ttsIndex : 0),
  getMasterStreamBytesReceived: () => (typeof sessionMasterStream !== 'undefined' && sessionMasterStream && typeof sessionMasterStream.getBytesReceived === 'function' ? sessionMasterStream.getBytesReceived() : 0),
  getDebugState: () => ({
    isTtsActive: typeof isTtsActive !== 'undefined' ? isTtsActive : false,
    currentTtsCookie: typeof currentTtsCookie !== 'undefined' ? currentTtsCookie : '',
    pendingTtsCount,
    bufferedPlayCount,
    totalWordsSent,
    totalTtsWavBytesReceived: totalBytesReceived,
    masterStreamBytesReceived: typeof sessionMasterStream !== 'undefined' && sessionMasterStream && typeof sessionMasterStream.getBytesReceived === 'function' ? sessionMasterStream.getBytesReceived() : 0,
    masterStreamChunksCount: typeof sessionMasterStream !== 'undefined' && sessionMasterStream && typeof sessionMasterStream.getChunkCount === 'function' ? sessionMasterStream.getChunkCount() : 0,
    receivedFramesCount: typeof receivedStreamFrames !== 'undefined' ? receivedStreamFrames.length : 0,
    pendingResolvers: typeof chunkPlaybackResolvers !== 'undefined' ? Array.from(chunkPlaybackResolvers.keys()) : [],
    queueLength: typeof ttsQueue !== 'undefined' ? ttsQueue.length : 0,
    receivedStreamFrames: typeof receivedStreamFrames !== 'undefined' ? receivedStreamFrames : [],
  })
};
