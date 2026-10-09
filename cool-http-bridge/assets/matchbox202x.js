(function(window) {
  'use strict';

  function getForwardedByHeader(existingHeader = null) {
    let forwardedBy = 'matchbox202x.js';
    try {
      if (window.location.pathname.startsWith('/apps/')) {
        const appName = window.location.pathname.split('/')[2];
        if (appName) forwardedBy += ` (${appName})`;
      }
    } catch (e) {}
    if (existingHeader) {
      forwardedBy = existingHeader + ', ' + forwardedBy;
    }
    return forwardedBy;
  }

  // --- window.xintent ---
  window.xintent = window.xintent || {
    SYN: 1,
    FIN: 2,
    SYN_FIN: 3,

    /**
     * Dispatch an intent to the matchbox202x platform
     * @param {string} intent - e.g., 'ui.TextToSpeech'
     * @param {Object} payload - Data payload to send with intent
     * @param {string} [app='localhost'] - Target application or node
     * @returns {Promise<Response>}
     */
    intent: async function(intent, payload = {}, app = 'localhost', options = {}) {
      const parts = intent.split('.');
      if (parts.length < 2) {
        throw new Error("Invalid intent format. Must be 'namespace.action' (e.g. 'ui.TextToSpeech')");
      }
      const [namespace, action] = parts;
      const endpoint = `/intent/${namespace}/${action}?app=${encodeURIComponent(app)}`;

      const headers = { 'Content-Type': 'application/json' };

      const opts = (typeof options === 'object' && options !== null) ? options : {};
      if (opts.Prefer) payload.Prefer = opts.Prefer;
      if (opts.receive_data === false || opts.receiveData === false) payload.Prefer = 'return=minimal';

      if (payload.receive_data === false || payload.receiveData === false) {
        payload.Prefer = 'return=minimal';
      }

      // Auto-infer SYN control word if expecting a stream (has Accept header) but not specified
      if (payload.controlWord === undefined && payload.Accept) {
        payload.controlWord = 1;
      }

      if (payload.controlWord !== undefined) {
        const ctrlStrings = [];
        if (payload.controlWord & 1) ctrlStrings.push('SYN');
        if (payload.controlWord & 2) ctrlStrings.push('FIN');
        if (ctrlStrings.length > 0) {
          headers['X-Channel-Control'] = ctrlStrings.join(',');
        }
      }
      if (payload.Accept) {
        headers['Accept'] = payload.Accept;
      }
      if (payload.Prefer) {
        headers['Prefer'] = payload.Prefer;
      }
      headers['X-Forwarded-By'] = getForwardedByHeader(payload['X-Forwarded-By']);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: headers,
          cache: 'no-store',
          body: JSON.stringify(payload)
        });
        response.parseMultipart = async function() {
          const text = await this.text();
          return window.xintent.parseMultipartResponse(text);
        };
        response.readMultipartStream = async function(onFrame) {
          return window.xintent.readMultipartStream(this, onFrame);
        };
        return response;
      } catch (err) {
        console.warn('[xintent] Intent dispatch warning:', err);
        throw err;
      }
    },

    /**
     * Reads and yields multipart frames in real-time from an active Fetch Response stream.
     * @param {Response} response
     * @param {function(frame: { headers: Record<string, string>, json?: any, body?: string }): void} onFrame
     * @returns {Promise<void>}
     */
    readMultipartStream: async function(response, onFrame) {
      if (!response || !response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let boundary = null;
      let totalBytesReceived = 0;
      let chunkCount = 0;

      response.getBytesReceived = () => totalBytesReceived;
      response.getChunkCount = () => chunkCount;
      window.xintent.lastStreamMetrics = {
        getBytesReceived: () => totalBytesReceived,
        getChunkCount: () => chunkCount,
      };

      while (true) {
        const { value, done } = await reader.read();
        if (value) {
          totalBytesReceived += value.byteLength;
          chunkCount++;
          buffer += decoder.decode(value, { stream: true });
        }

        if (!boundary && buffer.includes('MatchboxFrameBoundary')) {
          const lines = buffer.split(/\r?\n/);
          for (const line of lines) {
            if (line.includes('MatchboxFrameBoundary')) {
              let b = line.trim();
              if (b.startsWith('--')) b = b.slice(2);
              if (b.endsWith('--')) b = b.slice(0, -2);
              boundary = b;
              break;
            }
          }
        }

        if (boundary) {
          const delimiter = '--' + boundary;
          let parts = buffer.split(delimiter);

          // We will retain the last part in buffer only if it is incomplete
          let remainingBuffer = parts.pop() || '';

          for (const part of parts) {
            const trimmed = part.trim();
            if (!trimmed || trimmed === '--' || trimmed.startsWith('--')) continue;

            const headerEnd = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
            if (headerEnd === -1) continue;

            const headerText = part.slice(0, headerEnd);
            const bodyText = part.slice(headerEnd).trim();

            const headers = {};
            headerText.split(/\r?\n/).forEach(line => {
              const colon = line.indexOf(':');
              if (colon !== -1) {
                headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
              }
            });

            let json = null;
            try {
              json = JSON.parse(bodyText);
            } catch (_) {}

            if (typeof onFrame === 'function') {
              onFrame({ headers, json, body: bodyText });
            }
          }

          // Check if remainingBuffer itself contains a complete, valid frame
          const remainingTrimmed = remainingBuffer.trim();
          if (remainingTrimmed && remainingTrimmed !== '--' && !remainingTrimmed.startsWith('--')) {
            const headerEnd = remainingBuffer.indexOf('\r\n\r\n') !== -1 ? remainingBuffer.indexOf('\r\n\r\n') : remainingBuffer.indexOf('\n\n');
            if (headerEnd !== -1) {
              const headerText = remainingBuffer.slice(0, headerEnd);
              const bodyText = remainingBuffer.slice(headerEnd).trim();
              let json = null;
              try {
                json = JSON.parse(bodyText);
                if (json) {
                  const headers = {};
                  headerText.split(/\r?\n/).forEach(line => {
                    const colon = line.indexOf(':');
                    if (colon !== -1) {
                      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
                    }
                  });
                  if (typeof onFrame === 'function') {
                    onFrame({ headers, json, body: bodyText });
                  }
                  remainingBuffer = '';
                }
              } catch (_) {}
            }
          }

          buffer = remainingBuffer;
        }

        if (done) break;
      }
    },

    /**
     * Parses a multipart/mixed response text string into an array of frame objects.
     * @param {string} responseText
     * @returns {Array<{ headers: Record<string, string>, json?: any, body?: string }>}
     */
    parseMultipartResponse: function(responseText) {
      const parts = [];
      if (!responseText || typeof responseText !== 'string') return parts;

      if (!responseText.includes('MatchboxFrameBoundary')) {
        try {
          parts.push({ headers: {}, json: JSON.parse(responseText) });
        } catch (_) {
          parts.push({ headers: {}, body: responseText });
        }
        return parts;
      }

      const lines = responseText.split(/\r?\n/);
      const boundary = lines[0].trim();
      const rawParts = responseText.split(boundary).filter(p => p.trim() && !p.includes('--\r') && !p.includes('--\n'));

      for (const part of rawParts) {
        const headerEnd = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
        if (headerEnd === -1) continue;

        const headerText = part.slice(0, headerEnd);
        const bodyText = part.slice(headerEnd).trim();

        const headers = {};
        headerText.split(/\r?\n/).forEach(line => {
          const colon = line.indexOf(':');
          if (colon !== -1) {
            const k = line.slice(0, colon).trim().toLowerCase();
            const v = line.slice(colon + 1).trim();
            headers[k] = v;
          }
        });

        try {
          const json = JSON.parse(bodyText);
          parts.push({ headers, json, body: bodyText });
        } catch (_) {
          parts.push({ headers, body: bodyText });
        }
      }
      return parts;
    },

    /**
     * Retrieve intent and app registration tags from the bridge API
     * @returns {Promise<{intents: Record<string, string[]>, apps: Record<string, any>}>}
     */
    getTags: async function() {
      const res = await fetch('/api/tags', {
        headers: { 'X-Forwarded-By': getForwardedByHeader() }
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return res.json();
    }
  };

  // --- window.xblob ---
  window.xblob = window.xblob || {
    /**
     * Create an XBlob on the bridge
     * @param {Object} blobData - Content payload
     * @returns {Promise<{ status: string, blobId: number, blob: number }>}
     */
    XBlobCreate: async function(blobData = {}) {
      const res = await fetch('/xblob/XBlobCreate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
        body: JSON.stringify(blobData)
      });
      if (!res.ok) throw new Error(`XBlobCreate failed: HTTP ${res.status}`);
      return res.json();
    },

    /**
     * Transfer an XBlob to a grantee
     * @param {number|string} blobId
     * @param {number|string|null} [grantee=null]
     * @returns {Promise<{ status: string, blobId: number }>}
     */
    XBlobTransfer: async function(blobId, grantee = null) {
      const res = await fetch('/xblob/XBlobTransfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
        body: JSON.stringify({ blobId: blobId, blob: blobId, grantee: grantee })
      });
      if (!res.ok) throw new Error(`XBlobTransfer failed: HTTP ${res.status}`);
      return res.json();
    },

    /**
     * Grant rights to an XBlob
     * @param {number|string} blobId
     * @param {number|string|null} [grantee=null]
     * @returns {Promise<{ status: string, blobId: number }>}
     */
    XBlobGrant: async function(blobId, grantee = null) {
      const res = await fetch('/xblob/XBlobGrant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
        body: JSON.stringify({ blobId: blobId, blob: blobId, grantee: grantee })
      });
      if (!res.ok) throw new Error(`XBlobGrant failed: HTTP ${res.status}`);
      return res.json();
    },

    /**
     * Unlink an XBlob
     * @param {number|string} blobId
     * @returns {Promise<{ status: string, blobId: number }>}
     */
    XBlobUnlink: async function(blobId) {
      const res = await fetch('/xblob/XBlobUnlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
        body: JSON.stringify({ blobId: blobId, blob: blobId })
      });
      if (!res.ok) throw new Error(`XBlobUnlink failed: HTTP ${res.status}`);
      return res.json();
    },

    /**
     * Broadcast an XBlob update
     * @param {number|string} blobId
     * @param {string|null} [host=null]
     * @param {number|null} [version=null]
     * @returns {Promise<{ status: string, blobId: number }>}
     */
    XBlobBroadcast: async function(blobId, host = null, version = null) {
      const res = await fetch('/xblob/XBlobBroadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
        body: JSON.stringify({ blobId: blobId, blob: blobId, host: host, version: version })
      });
      if (!res.ok) throw new Error(`XBlobBroadcast failed: HTTP ${res.status}`);
      return res.json();
    }
  };

  // Method aliases
  window.xblob.create = window.xblob.XBlobCreate;
  window.xblob.transfer = window.xblob.XBlobTransfer;
  window.xblob.grant = window.xblob.XBlobGrant;
  window.xblob.unlink = window.xblob.XBlobUnlink;
  window.xblob.broadcast = window.xblob.XBlobBroadcast;

  // --- window.xaudio ---
  window.xaudio = window.xaudio || {
    /**
     * Connect a dedicated WebSocket for real-time XAudio response events
     * @param {function(frame: any): void} [onFrameHandler=null]
     * @returns {WebSocket}
     */
    connectXAudioWs: function(onFrameHandler = null, sinkName = 'user-desktop-speakers') {
      this._wsListeners = this._wsListeners || new Set();
      if (typeof onFrameHandler === 'function') {
        this._wsListeners.add(onFrameHandler);
      }

      if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
        return this._ws;
      }

      const wsProtocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/xaudio?XAudioSink=${encodeURIComponent(sinkName)}`;

      try {
        const ws = new WebSocket(wsUrl);
        this._ws = ws;

        ws.onopen = () => {
          console.log('[xaudio] Real-time WebSocket connected to /xaudio');
        };

        ws.onmessage = (event) => {
          try {
            const frame = JSON.parse(event.data);
            for (const listener of this._wsListeners) {
              try { listener(frame); } catch (_) {}
            }
          } catch (_) {}
        };

        ws.onclose = () => {
          this._ws = null;
        };

        return ws;
      } catch (err) {
        console.warn('[xaudio] Could not establish /xaudio WebSocket:', err);
        return null;
      }
    },

    /**
     * Play a sound sample/blob on XAudioSink with sequential ordering & automatic transfer
     * @param {Object|string|number} cookieOrOptions - Options object or cookie string
     * @param {number} [seqnum=0] - Sequence number
     * @param {number|string} [sample=null] - XBlob ID
     * @returns {Promise<Response>}
     */
    XAudioPlay: async function(cookieOrOptions = {}, seqnum = 0, sample = null) {
      let options = {};
      if (typeof cookieOrOptions === 'object' && cookieOrOptions !== null) {
        options = cookieOrOptions;
      } else {
        options = {
          cookie: cookieOrOptions,
          seqnum: seqnum,
          sample: sample || seqnum,
        };
      }

      const cookie = options.cookie || options.Cookie || options.OutputId || 'default';
      const seq = options.seqnum ?? options.seq ?? 0;
      const blobId = options.sample || options.blob || options.blobId || options.BlobId;
      const app = options.app || 'localhost';
      const streamId = options.streamId ?? options.stream ?? 1;
      const volume = options.volume ?? 1.0;
      const loop = !!options.loop;
      const controlWord = options.controlWord ?? (window.xintent ? window.xintent.SYN : 1);

      if (options.transferBlob !== false && blobId) {
        try {
          await window.xblob.XBlobTransfer(blobId);
        } catch (err) {
          console.warn('[xaudio] Automatic XBlobTransfer warning:', err);
        }
      }

      const payload = {
        intent: 'xaudio.PlaySoundBlob',
        app: app,
        OutputId: cookie,
        cookie: cookie,
        streamId: streamId,
        seqnum: seq,
        sample: blobId,
        blobId: blobId,
        BlobId: blobId,
        volume: volume,
        loop: loop,
        controlWord: controlWord,
        ...options
      };

      const ws = this.connectXAudioWs(null, app);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(payload));
        } else {
          ws.addEventListener('open', () => {
            try { ws.send(JSON.stringify(payload)); } catch (_) {}
          }, { once: true });
        }
        return new Response(JSON.stringify({ status: 200, queued: true, seqnum: seq, via: 'websocket' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return window.xintent.intent('xaudio.PlaySoundBlob', payload, app);
    },

    /**
     * Prefetch a sound blob on XAudioSink
     * @param {Object} options
     * @returns {Promise<Response>}
     */
    prefetchSoundBlob: async function(options = {}) {
      const cookie = options.cookie || options.Cookie || options.OutputId || 'default';
      const blobId = options.sample || options.blob || options.blobId || options.BlobId;
      const app = options.app || 'localhost';
      if (options.transferBlob !== false && blobId) {
        try {
          await window.xblob.XBlobTransfer(blobId);
        } catch (err) {
          console.warn('[xaudio] Automatic XBlobTransfer warning:', err);
        }
      }
      return window.xintent.intent('xaudio.PrefetchSoundBlob', {
        intent: 'xaudio.PrefetchSoundBlob',
        app: app,
        OutputId: cookie,
        cookie: cookie,
        sample: blobId,
        blobId: blobId,
        BlobId: blobId,
        ...options
      }, app);
    },

    /**
     * Send control commands to XAudio (stop, pause, etc.)
     * @param {Object|string} options
     * @returns {Promise<Response>}
     */
    controlStream: async function(options = {}) {
      const command = typeof options === 'string' ? options : (options.command || 'stop');
      const cookie = (typeof options === 'object') ? (options.cookie || options.OutputId || 'default') : 'default';
      const streamId = (typeof options === 'object') ? (options.streamId ?? options.stream ?? 1) : 1;
      const app = (typeof options === 'object' && options.app) ? options.app : 'localhost';
      return window.xintent.intent('xaudio.ControlStream', {
        intent: 'xaudio.ControlStream',
        command: command,
        cookie: cookie,
        OutputId: cookie,
        streamId: streamId,
        app: app,
        ...(typeof options === 'object' ? options : {})
      }, app);
    },

    /**
     * Seek a stream to a specific position
     * @param {Object} options
     * @returns {Promise<Response>}
     */
    seekStream: async function(options = {}) {
      const seekTo = options.seekTo ?? 0;
      const streamId = options.streamId ?? options.stream ?? 1;
      const cookie = options.cookie || options.OutputId || 'default';
      const app = options.app || 'localhost';
      return window.xintent.intent('xaudio.SeekStream', {
        intent: 'xaudio.SeekStream',
        command: 'seek',
        seekTo: seekTo,
        streamId: streamId,
        cookie: cookie,
        OutputId: cookie,
        app: app,
        ...options
      }, app);
    }
  };
})(window);
