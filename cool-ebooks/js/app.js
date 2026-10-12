// Application initialization, XIntent bridge loader, & WebSocket connection

async function ensureXIntent() {
  if (window.xintent && typeof window.xintent.readMultipartStream === 'function') return window.xintent;

  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = '/matchbox202x.js?t=' + Date.now();
    script.onload = () => resolve(window.xintent);
    script.onerror = () => resolve(window.xintent);
    document.head.appendChild(script);
  });
}

function initApp() {
  // Pre-load xintent, connect real-time /xaudio WebSocket, restore saved state, and attach listeners
  ensureXIntent().then(() => {
    if (window.xaudio && typeof window.xaudio.connectXAudioWs === 'function') {
      window.xaudio.connectXAudioWs((frame) => {
        if (frame) {
          receivedStreamFrames.push({
            time: new Date().toLocaleTimeString('en-US', { hour12: false }),
            frame: frame
          });
        }
        console.log('[cool-ebooks] WebSocket frame received:', frame);
        if (typeof handleXAudioFrame === 'function') {
          handleXAudioFrame(frame, 'WebSocket');
        }
      });
    }
  });

  if (typeof populateTagsOptions === 'function') {
    populateTagsOptions();
  }
  if (typeof restoreSavedState === 'function') {
    restoreSavedState();
  }
  if (typeof setupReaderEventListeners === 'function') {
    setupReaderEventListeners();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
