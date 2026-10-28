// Double-Buffered TTS Pipeline & XAudio Stream Manager

let ttsQueue = [];
let ttsIndex = 0;
let isTtsActive = false;
let currentTtsPromise = null;
let nextTtsPromise = null;
let currentTtsCookie = 'tts_session_' + Date.now();
let lastSpokenPageText = '';

const chunkPlaybackResolvers = new Map(); // seqnum -> resolveFn
let sessionMasterStream = null;
const receivedStreamFrames = [];

const DEFAULT_FALLBACK_BOOK_TEXT =
  "In the beginning God created the heavens and the earth. And the earth was formless and void; and darkness was upon the face of the deep. And the Spirit of God moved upon the face of the waters. And God said, Let there be light: and there was light.";

// Helper to extract string blob ID
function extractBlobId(rawBlob) {
  if (!rawBlob) return null;
  if (typeof rawBlob === 'string') return rawBlob;
  if (typeof rawBlob === 'object') {
    return rawBlob.id || rawBlob.blobId || rawBlob.data_blob || rawBlob.blob || null;
  }
  return String(rawBlob);
}

// Break raw text into sentence/word chunks
function chunkText(rawText, chunkSizeWords = 25) {
  const cleanText = (rawText || '').replace(/\s+/g, ' ').trim();
  if (!cleanText) return [];

  const sentences = cleanText.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let currentChunk = '';

  for (const sentence of sentences) {
    const wordCount = (currentChunk + ' ' + sentence).trim().split(/\s+/).length;
    if (currentChunk && wordCount > chunkSizeWords) {
      chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk = (currentChunk + ' ' + sentence).trim();
    }
  }
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}

// Convert ArrayBuffer to Base64
function bufferToBase64(arrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Convert Base64 / Data URL to ArrayBuffer
function base64ToBuffer(base64Str) {
  if (typeof base64Str !== 'string') return base64Str;
  const cleanBase64 = base64Str.includes(',') ? base64Str.split(',')[1] : base64Str;
  const binaryString = window.atob(cleanBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function getSelectedElementValue(id, fallback) {
  const el = document.getElementById(id);
  return (el && el.value) ? el.value : fallback;
}

function handleXAudioFrame(frameData, source = 'ws') {
  const json = frameData && (frameData.json || frameData);
  if (!json) return;

  const evt = json.event || json.intent;
  const isPlayResp = evt === 'XAudioPlayResponseV0' || evt === 'xaudio.PlaySoundBlobResponse' || json.seqnum !== undefined;
  if (!isPlayResp || json.seqnum === undefined || !chunkPlaybackResolvers.has(json.seqnum)) {
    return;
  }

  const targetNode = getSelectedElementValue('xaudio-node-select', 'default');
  logDebug(`[XAudioPlayResponse (${source})] ${targetNode} confirmed playback for seq #${json.seqnum + 1}`);
  const resolveFn = chunkPlaybackResolvers.get(json.seqnum);
  chunkPlaybackResolvers.delete(json.seqnum);
  resolveFn(json);
}

async function listenToSessionMasterStream(response, targetXAudioNode) {
  if (!response || typeof response.readMultipartStream !== 'function') return;

  try {
    await response.readMultipartStream((frame) => {
      if (frame) {
        receivedStreamFrames.push({
          time: new Date().toLocaleTimeString('en-US', { hour12: false }),
          frame: frame
        });
      }
      console.log('[cool-ebooks] Master stream frame received:', frame);
      handleXAudioFrame(frame, 'HTTP-Stream');
    });
  } catch (err) {
    console.warn('[cool-ebooks] Master stream reader closed:', err);
  }
}

async function requestTtsWithRetry(xintent, ttsPayload, targetTtsApp, seqnum) {
  try {
    return await xintent.intent('ui.TextToSpeech', ttsPayload, targetTtsApp);
  } catch (firstErr) {
    if (!isTtsActive) return null;
    console.warn(`[cool-ebooks] Initial TTS request for chunk #${seqnum + 1} failed (${firstErr.message}), retrying...`);
    await new Promise((r) => setTimeout(r, 600));
    if (!isTtsActive) return null;
    return await xintent.intent('ui.TextToSpeech', ttsPayload, targetTtsApp);
  }
}

function extractBlobInfoFromPart(part, state) {
  const hdrBlob = part.headers && (part.headers['x-attached-blob-id'] || part.headers['x-blob-id']);
  if (hdrBlob) {
    state.blobId = extractBlobId(hdrBlob);
  }
  if (!part.json) return;

  const jsonBlob = part.json.data_blob || part.json.blobId || part.json.blob;
  if (jsonBlob) {
    state.blobId = extractBlobId(jsonBlob);
  }
  if (part.json.data) {
    state.inlineBase64Data = part.json.data;
    const buf = base64ToBuffer(part.json.data);
    state.wavByteLength = buf ? buf.byteLength : 0;
  }
}

async function parseMultipartTtsResponse(response) {
  const state = { wavByteLength: 0, blobId: null, inlineBase64Data: null };
  if (!response || !response.ok) return state;

  try {
    const parts = typeof response.parseMultipart === 'function'
      ? await response.parseMultipart()
      : window.xintent.parseMultipartResponse(await response.text());
    for (const part of parts) {
      extractBlobInfoFromPart(part, state);
    }
  } catch (e) {
    console.warn('[cool-ebooks] error parsing multipart TTS response:', e);
  }
  return state;
}

async function ensureXBlobForInlineAudio(blobId, inlineBase64Data) {
  if (blobId || !inlineBase64Data) return blobId;
  const xblob = window.xblob || (window.xintent && window.xintent.xblob);
  if (!xblob || typeof xblob.XBlobCreate !== 'function') return null;

  try {
    const created = await xblob.XBlobCreate({
      type: 'audio/wav',
      data: inlineBase64Data,
      _dataType: 'base64',
      xblobType: 'Blob'
    });
    return extractBlobId(created.blobId || created.blob || (created.json && created.json.blobId));
  } catch (e) {
    console.warn('[cool-ebooks] Failed to create XBlob for inline TTS audio:', e);
    return null;
  }
}

async function streamBlobToXAudio(blobId, seqnum, cookie, targetXAudioNode) {
  const xaudio = window.xaudio || (window.xintent && window.xintent.xaudio);
  if (!xaudio || typeof xaudio.XAudioPlay !== 'function' || !blobId) {
    logDebug(`[XAudio Warning] Chunk #${seqnum + 1}: Cannot play audio. xaudio available: ${Boolean(xaudio)}, blobId: ${blobId}`);
    return;
  }

  updatePipelineCounters(0, +1);
  logDebug(`[XAudioPlay] Streaming XBlob ${blobId} (seq #${seqnum + 1}, ctrl: SYN) to ${targetXAudioNode}...`);

  const playbackConfirmedPromise = new Promise((resolve) => {
    chunkPlaybackResolvers.set(seqnum, resolve);
  });

  const playRes = await xaudio.XAudioPlay({
    cookie: cookie,
    OutputId: cookie,
    app: targetXAudioNode,
    streamId: 1,
    seqnum: seqnum,
    sample: blobId,
    blob: blobId,
    controlWord: window.xintent ? window.xintent.SYN : 1,
    headers: { 'Connection': 'keep-alive' },
    transferBlob: true
  });

  if (playRes && typeof playRes.readMultipartStream === 'function') {
    listenToSessionMasterStream(playRes, targetXAudioNode);
  }

  await playbackConfirmedPromise;
  updatePipelineCounters(0, -1);
}

// Dispatch a single chunk to ui.TextToSpeech and stream audio to XAudioSink
async function dispatchTtsChunk(text, seqnum = 0, cookie = currentTtsCookie) {
  const targetTtsApp = getSelectedElementValue('tts-app-select', 'cool-tts');
  const targetXAudioNode = getSelectedElementValue('xaudio-node-select', 'default');
  const wordCount = (text || '').trim().split(/\s+/).filter(Boolean).length;
  const startTime = performance.now();

  updatePipelineCounters(+1, 0);
  logDebug(`[ui.TextToSpeech] Dispatching Chunk #${seqnum + 1} (${wordCount} words) to ${targetTtsApp}...`);

  const xintent = await ensureXIntent();
  if (!xintent || typeof xintent.intent !== 'function') return;

  try {
    const ttsPayload = {
      intent: 'ui.TextToSpeech',
      app: targetTtsApp,
      text: text,
      speed: 1.0,
      reply: true,
      controlWord: xintent.SYN,
      receive_data: false,
      Accept: 'audio/wav'
    };

    const response = await requestTtsWithRetry(xintent, ttsPayload, targetTtsApp, seqnum);
    if (!response && !isTtsActive) return false;

    const rttMs = Math.round(performance.now() - startTime);
    const parsed = await parseMultipartTtsResponse(response);
    const blobId = await ensureXBlobForInlineAudio(parsed.blobId, parsed.inlineBase64Data);

    updatePipelineCounters(-1, 0);
    updateDebugMetrics(wordCount, parsed.wavByteLength, rttMs);
    logDebug(`[ui.TextToSpeechResponse] Chunk #${seqnum + 1}: Received ${formatBytes(parsed.wavByteLength)} WAV (XBlob ${blobId || 'none'}) in ${rttMs}ms`);

    await streamBlobToXAudio(blobId, seqnum, cookie, targetXAudioNode);
    return true;
  } catch (err) {
    updatePipelineCounters(-1, 0);
    logDebug(`[TTS ERROR] Chunk #${seqnum + 1} failed: ${err.message || err}`);
    console.warn('[cool-ebooks] xintent dispatch failed:', err);
  }
}

function resolvePageTextForTts(isAutoAdvance) {
  let rawText = typeof getVisiblePageText === 'function' ? getVisiblePageText() : '';
  if (!rawText) {
    if (typeof rendition === 'undefined' || !rendition) {
      rawText = DEFAULT_FALLBACK_BOOK_TEXT;
    } else {
      updateTtsStatus("End of section or no visible text found.");
      stopTts(false);
      return null;
    }
  }

  if (isAutoAdvance && rawText === lastSpokenPageText) {
    updateTtsStatus("Reached end of book.");
    stopTts(false);
    return null;
  }

  lastSpokenPageText = rawText;
  return rawText;
}

async function executePipelinedTtsQueue(queue, cookie, pipelineDepth = 3) {
  const activePromises = [];
  for (let i = 0; i < queue.length; i++) {
    if (!isTtsActive) break;

    updateTtsStatus(`[Speaking Chunk ${i + 1}/${queue.length}] (${activePromises.length + 1} active in pipeline):\n"${queue[i]}"`);
    const p = dispatchTtsChunk(queue[i], i, cookie);
    activePromises.push(p);

    p.finally(() => {
      const idx = activePromises.indexOf(p);
      if (idx !== -1) activePromises.splice(idx, 1);
    });

    if (activePromises.length >= pipelineDepth) {
      await Promise.race(activePromises);
    }
  }
  await Promise.all(activePromises);
}

// Double-Buffered TTS Execution Loop
async function startDoubleBufferedTts(isAutoAdvance = false) {
  if (isTtsActive) return;

  const rawText = resolvePageTextForTts(isAutoAdvance);
  if (!rawText) return;

  const chunkSize = parseInt(getSelectedElementValue('chunk-size', '25'), 10) || 25;
  ttsQueue = chunkText(rawText, chunkSize);

  if (ttsQueue.length === 0) {
    updateTtsStatus("No text available to speak.");
    return;
  }

  isTtsActive = true;
  ttsIndex = 0;
  const ttsPlayBtn = document.getElementById('tts-play');
  if (ttsPlayBtn) ttsPlayBtn.disabled = true;
  currentTtsCookie = 'tts_session_' + Date.now();

  updateTtsStatus(`[TTS Pipelining Started] ${ttsQueue.length} chunks prepared.`);
  await executePipelinedTtsQueue(ttsQueue, currentTtsCookie, 3);

  if (!isTtsActive) {
    stopTts(false);
    return;
  }

  updateTtsStatus("Finished page. Advancing to next page...");
  if (typeof handlePageFlip === 'function') {
    await handlePageFlip('next', true);
  }
}

function sendControlStopSignal(cookieToStop) {
  const stopPayload = {
    command: 'stop',
    cookie: cookieToStop,
    streamId: 1,
    controlWord: window.xintent ? window.xintent.FIN : 2,
    headers: { 'X-Channel-Control': 'FIN' }
  };

  if (window.xaudio && typeof window.xaudio.controlStream === 'function') {
    window.xaudio.controlStream(stopPayload).catch(() => {});
  } else if (window.xintent && typeof window.xintent.intent === 'function') {
    window.xintent.intent('xaudio.ControlStream', stopPayload).catch(() => {});
  }
}

async function stopTts(sendControlStop = true) {
  const wasActive = isTtsActive;
  isTtsActive = false;
  ttsQueue = [];
  ttsIndex = 0;
  sessionMasterStream = null;
  chunkPlaybackResolvers.clear();
  currentTtsPromise = null;
  nextTtsPromise = null;
  lastSpokenPageText = '';

  const ttsPlayBtn = document.getElementById('tts-play');
  if (ttsPlayBtn) ttsPlayBtn.disabled = false;

  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }

  if (wasActive && sendControlStop) {
    sendControlStopSignal(currentTtsCookie);
  }

  updateTtsStatus("TTS Stopped. Buffers dropped.");
}
