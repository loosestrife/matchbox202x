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
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Convert Base64 / Data URL to ArrayBuffer
function base64ToBuffer(base64Str) {
  if (typeof base64Str !== 'string') return base64Str;
  const cleanBase64 = base64Str.includes(',') ? base64Str.split(',')[1] : base64Str;
  const binaryString = window.atob(cleanBase64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function handleXAudioFrame(frameData, source = 'ws') {
  if (!frameData) return;
  const json = frameData.json || frameData;
  if (!json) return;

  const evt = json.event || json.intent;
  if (evt === 'XAudioPlayResponseV0' || evt === 'xaudio.PlaySoundBlobResponse' || json.seqnum !== undefined) {
    const seqnum = json.seqnum;
    if (seqnum !== undefined && chunkPlaybackResolvers.has(seqnum)) {
      const xaudioNodeSelect = document.getElementById('xaudio-node-select');
      const targetNode = xaudioNodeSelect ? xaudioNodeSelect.value || 'default' : 'default';
      logDebug(`[XAudioPlayResponse (${source})] ${targetNode} confirmed playback for seq #${seqnum + 1}`);
      const resolveFn = chunkPlaybackResolvers.get(seqnum);
      chunkPlaybackResolvers.delete(seqnum);
      resolveFn(json);
    }
  }
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

// Dispatch a single chunk to ui.TextToSpeech and stream audio to XAudioSink
async function dispatchTtsChunk(text, seqnum = 0, cookie = currentTtsCookie) {
  const ttsAppSelect = document.getElementById('tts-app-select');
  const xaudioNodeSelect = document.getElementById('xaudio-node-select');

  const targetTtsApp = ttsAppSelect ? ttsAppSelect.value || 'cool-tts' : 'cool-tts';
  const targetXAudioNode = xaudioNodeSelect ? xaudioNodeSelect.value || 'default' : 'default';

  const wordCount = (text || '').trim().split(/\s+/).filter(Boolean).length;
  const startTime = performance.now();

  updatePipelineCounters(+1, 0);
  logDebug(`[ui.TextToSpeech] Dispatching Chunk #${seqnum + 1} (${wordCount} words) to ${targetTtsApp}...`);

  const xintent = await ensureXIntent();
  if (xintent && typeof xintent.intent === 'function') {
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

      let response = null;
      try {
        response = await xintent.intent('ui.TextToSpeech', ttsPayload, targetTtsApp);
      } catch (firstErr) {
        if (!isTtsActive) return false;
        console.warn(`[cool-ebooks] Initial TTS request for chunk #${seqnum + 1} failed (${firstErr.message}), retrying...`);
        await new Promise(r => setTimeout(r, 600));
        if (!isTtsActive) return false;
        response = await xintent.intent('ui.TextToSpeech', ttsPayload, targetTtsApp);
      }

      const endTime = performance.now();
      const rttMs = Math.round(endTime - startTime);

      let wavByteLength = 0;
      let blobId = null;
      let inlineBase64Data = null;

      if (response && response.ok) {
        try {
          const parts = typeof response.parseMultipart === 'function'
            ? await response.parseMultipart()
            : window.xintent.parseMultipartResponse(await response.text());

          for (const part of parts) {
            if (part.headers && part.headers['x-attached-blob-id']) {
              blobId = extractBlobId(part.headers['x-attached-blob-id']);
            }
            if (part.headers && part.headers['x-blob-id']) {
              blobId = extractBlobId(part.headers['x-blob-id']);
            }
            if (part.json) {
              if (part.json.data_blob || part.json.blobId || part.json.blob) {
                blobId = extractBlobId(part.json.data_blob || part.json.blobId || part.json.blob);
              }
              if (part.json.data) {
                inlineBase64Data = part.json.data;
                const buf = base64ToBuffer(part.json.data);
                wavByteLength = buf ? buf.byteLength : 0;
              }
            }
          }
        } catch (e) {
          console.warn('[cool-ebooks] error parsing multipart TTS response:', e);
        }
      }

      // If no XBlob ID was returned directly by TTS, but inline audio data was provided, create an XBlob
      const xblob = window.xblob || (window.xintent && window.xintent.xblob);
      if (!blobId && inlineBase64Data && xblob && typeof xblob.XBlobCreate === 'function') {
        try {
          const created = await xblob.XBlobCreate({
            type: 'audio/wav',
            data: inlineBase64Data,
            _dataType: 'base64',
            xblobType: 'Blob'
          });
          blobId = extractBlobId(created.blobId || created.blob || (created.json && created.json.blobId));
        } catch (e) {
          console.warn('[cool-ebooks] Failed to create XBlob for inline TTS audio:', e);
        }
      }

      updatePipelineCounters(-1, 0);
      updateDebugMetrics(wordCount, wavByteLength, rttMs);
      logDebug(`[ui.TextToSpeechResponse] Chunk #${seqnum + 1}: Received ${formatBytes(wavByteLength)} WAV (XBlob ${blobId || 'none'}) in ${rttMs}ms`);

      const xaudio = window.xaudio || (window.xintent && window.xintent.xaudio);
      if (xaudio && typeof xaudio.XAudioPlay === 'function' && blobId) {
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
          headers: {
            'Connection': 'keep-alive'
          },
          transferBlob: true
        });

        if (playRes && typeof playRes.readMultipartStream === 'function') {
          listenToSessionMasterStream(playRes, targetXAudioNode);
        }

        await playbackConfirmedPromise;
        updatePipelineCounters(0, -1);
      } else {
        logDebug(`[XAudio Warning] Chunk #${seqnum + 1}: Cannot play audio. xaudio available: ${Boolean(xaudio)}, blobId: ${blobId}`);
      }
      return true;
    } catch (err) {
      updatePipelineCounters(-1, 0);
      logDebug(`[TTS ERROR] Chunk #${seqnum + 1} failed: ${err.message || err}`);
      console.warn('[cool-ebooks] xintent dispatch failed:', err);
    }
  }
}

// Double-Buffered TTS Execution Loop
async function startDoubleBufferedTts(isAutoAdvance = false) {
  if (isTtsActive) return;

  let rawText = typeof getVisiblePageText === 'function' ? getVisiblePageText() : '';

  if (!rawText) {
    if (typeof rendition === 'undefined' || !rendition) {
      rawText = "In the beginning God created the heavens and the earth. And the earth was formless and void; and darkness was upon the face of the deep. And the Spirit of God moved upon the face of the waters. And God said, Let there be light: and there was light.";
    } else {
      updateTtsStatus("End of section or no visible text found.");
      stopTts(false);
      return;
    }
  }

  // Detect reaching the end of the book during auto-advance
  if (isAutoAdvance && rawText === lastSpokenPageText) {
    updateTtsStatus("Reached end of book.");
    stopTts(false);
    return;
  }
  lastSpokenPageText = rawText;

  const chunkSizeSelect = document.getElementById('chunk-size');
  const chunkSize = chunkSizeSelect ? (parseInt(chunkSizeSelect.value, 10) || 25) : 25;
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

  const PIPELINE_DEPTH = 3;
  updateTtsStatus(`[TTS Pipelining Started] ${ttsQueue.length} chunks prepared.`);

  const activePromises = [];

  for (let i = 0; i < ttsQueue.length; i++) {
    if (!isTtsActive) break;

    updateTtsStatus(`[Speaking Chunk ${i + 1}/${ttsQueue.length}] (${activePromises.length + 1} active in pipeline):\n"${ttsQueue[i]}"`);

    const p = dispatchTtsChunk(ttsQueue[i], i, currentTtsCookie);
    activePromises.push(p);

    p.finally(() => {
      const idx = activePromises.indexOf(p);
      if (idx !== -1) activePromises.splice(idx, 1);
    });

    if (activePromises.length >= PIPELINE_DEPTH) {
      await Promise.race(activePromises);
    }
  }

  await Promise.all(activePromises);

  if (isTtsActive) {
    updateTtsStatus("Finished page. Advancing to next page...");
    // Auto-advance to next page and continue reading continuously!
    if (typeof handlePageFlip === 'function') {
      await handlePageFlip('next', true);
    }
  } else {
    stopTts(false);
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

  // Only send xaudio.ControlStream if TTS was actively playing AND sendControlStop is true
  if (wasActive && sendControlStop) {
    const cookieToStop = currentTtsCookie;
    if (window.xaudio && typeof window.xaudio.controlStream === 'function') {
      window.xaudio.controlStream({
        command: 'stop',
        cookie: cookieToStop,
        streamId: 1,
        controlWord: window.xintent ? window.xintent.FIN : 2,
        headers: {
          'X-Channel-Control': 'FIN'
        }
      }).catch(() => {});
    } else if (window.xintent && typeof window.xintent.intent === 'function') {
      window.xintent.intent('xaudio.ControlStream', {
        command: 'stop',
        cookie: cookieToStop,
        controlWord: window.xintent ? window.xintent.FIN : 2,
        headers: {
          'X-Channel-Control': 'FIN'
        }
      }).catch(() => {});
    }
  }

  updateTtsStatus("TTS Stopped. Buffers dropped.");
}
