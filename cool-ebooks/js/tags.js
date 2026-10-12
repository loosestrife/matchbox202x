// Populate TTS & XAudio options dynamically from /api/tags

async function populateTagsOptions() {
  const ttsAppSelect = document.getElementById('tts-app-select');
  const xaudioNodeSelect = document.getElementById('xaudio-node-select');

  try {
    const tags = await fetch('/api/tags').then(r => r.json());
    if (tags) {
      // 1. Populate TTS options
      const ttsProviders = tags.intents?.['ui.TextToSpeech'] || ['cool-tts'];
      if (ttsProviders.length > 0 && ttsAppSelect) {
        const currentVal = ttsAppSelect.value;
        ttsAppSelect.innerHTML = '';
        ttsProviders.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p;
          opt.textContent = `${p} ${p === 'cool-tts' ? '(Desktop Engine)' : (p === 'flammenwerfer-phone' ? '(Android Speech)' : '')}`;
          ttsAppSelect.appendChild(opt);
        });
        if (ttsProviders.includes(currentVal)) {
          ttsAppSelect.value = currentVal;
        }
      }

      // 2. Populate XAudioSink / XAudioNode options
      const sinks = Object.keys(tags.XAudioSink || tags.XAudioNode || {});
      if (xaudioNodeSelect) {
        const currentSink = xaudioNodeSelect.value || 'default';
        xaudioNodeSelect.innerHTML = '';

        const defaultOpt = document.createElement('option');
        defaultOpt.value = 'default';
        defaultOpt.textContent = 'Default (SESSION_SPEAKERS)';
        xaudioNodeSelect.appendChild(defaultOpt);

        sinks.forEach(s => {
          const opt = document.createElement('option');
          opt.value = s;
          opt.textContent = `${s} ${s.includes('phone') ? '(Phone Speaker)' : '(Desktop Speaker)'}`;
          xaudioNodeSelect.appendChild(opt);
        });

        if (['default', ...sinks].includes(currentSink)) {
          xaudioNodeSelect.value = currentSink;
        } else {
          xaudioNodeSelect.value = 'default';
        }
      }
    }
  } catch (e) {
    console.warn('[cool-ebooks] Could not fetch /api/tags for dynamic selector population:', e);
  }
}
