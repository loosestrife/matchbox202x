(function(window) {
  'use strict';

  if (window.xintent && typeof window.xintent.readMultipartStream === 'function' && typeof window.xintent.getFsMode === 'function') return;

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

  function applyIntentPreferences(payload, options) {
    const opts = (typeof options === 'object' && options !== null) ? options : {};
    if (opts.Prefer) payload.Prefer = opts.Prefer;
    const minimalRequested =
      opts.receive_data === false ||
      opts.receiveData === false ||
      payload.receive_data === false ||
      payload.receiveData === false;
    if (minimalRequested) {
      payload.Prefer = 'return=minimal';
    }
    if (payload.controlWord === undefined && payload.Accept) {
      payload.controlWord = 1;
    }
  }

  function formatControlWordHeader(controlWord) {
    if (controlWord === undefined) return null;
    const ctrlStrings = [];
    if (controlWord & 1) ctrlStrings.push('SYN');
    if (controlWord & 2) ctrlStrings.push('FIN');
    return ctrlStrings.length > 0 ? ctrlStrings.join(',') : null;
  }

  function buildIntentHeaders(payload) {
    const headers = { 'Content-Type': 'application/json' };
    const ctrlHeader = formatControlWordHeader(payload.controlWord);
    if (ctrlHeader) headers['X-Channel-Control'] = ctrlHeader;
    if (payload.Accept) headers['Accept'] = payload.Accept;
    if (payload.Prefer) headers['Prefer'] = payload.Prefer;
    if (payload.headers && typeof payload.headers === 'object') {
      Object.assign(headers, payload.headers);
    }
    const conn = payload.Connection || payload.connection;
    if (conn) headers['Connection'] = conn;
    headers['X-Forwarded-By'] = getForwardedByHeader(payload['X-Forwarded-By']);
    return headers;
  }

  function parseFrameHeaders(headerText) {
    const headers = {};
    headerText.split(/\r?\n/).forEach((line) => {
      const colon = line.indexOf(':');
      if (colon !== -1) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    });
    return headers;
  }

  function detectMultipartBoundary(buffer) {
    if (!buffer.includes('MatchboxFrameBoundary')) return null;
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      if (line.includes('MatchboxFrameBoundary')) {
        return line.trim().replace(/^--/, '').replace(/--$/, '');
      }
    }
    return null;
  }

  function findHeaderSeparatorIndex(part) {
    const crlfIdx = part.indexOf('\r\n\r\n');
    return crlfIdx !== -1 ? crlfIdx : part.indexOf('\n\n');
  }

  function parseMultipartPart(part, requireValidJson) {
    const trimmed = part.trim();
    if (!trimmed || trimmed.startsWith('--')) return null;
    const headerEnd = findHeaderSeparatorIndex(part);
    if (headerEnd === -1) return null;

    const headerText = part.slice(0, headerEnd);
    const bodyText = part.slice(headerEnd).trim();
    let json = null;
    try {
      json = JSON.parse(bodyText);
    } catch (_) {
      if (requireValidJson) return null;
    }
    if (requireValidJson && !json) return null;
    return { headers: parseFrameHeaders(headerText), json, body: bodyText };
  }

  function processMultipartBuffer(buffer, boundary, onFrame) {
    const parts = buffer.split('--' + boundary);
    let remainingBuffer = parts.pop() || '';

    for (const part of parts) {
      const frame = parseMultipartPart(part, false);
      if (frame && typeof onFrame === 'function') {
        onFrame(frame);
      }
    }

    const trailingFrame = parseMultipartPart(remainingBuffer, true);
    if (trailingFrame) {
      if (typeof onFrame === 'function') onFrame(trailingFrame);
      remainingBuffer = '';
    }
    return remainingBuffer;
  }

  function formatErrorDetails(errObj) {
    if (!errObj) return String(errObj);
    const keys = ['message', 'name', 'code', 'type', 'stack'];
    const details = keys.filter((k) => errObj[k]).map((k) => `${k}=${errObj[k]}`);
    return details.length > 0 ? details.join(', ') : String(errObj);
  }

  function parseWsAudioEventData(rawData) {
    if (typeof rawData !== 'string' || (!rawData.includes('Content-Type:') && !rawData.includes('MatchboxFrameBoundary'))) {
      return JSON.parse(rawData);
    }
    const parts = window.xintent ? window.xintent.parseMultipartResponse(rawData) : [];
    if (parts.length === 0) return null;
    const first = parts[0].json || parts[0].body;
    if (parts.length > 1 && parts[1].body) {
      return Object.assign({}, typeof first === 'object' ? first : { data: first }, { blob: parts[1].body });
    }
    return first;
  }

  function normalizePlayOptions(cookieOrOptions, seqnum, sample) {
    if (typeof cookieOrOptions === 'object' && cookieOrOptions !== null) {
      return cookieOrOptions;
    }
    return {
      cookie: cookieOrOptions,
      seqnum: seqnum,
      sample: sample || seqnum,
    };
  }

  // --- window.xintent ---
  window.xintent = window.xintent || {
    SYN: 1,
    FIN: 2,
    SYN_FIN: 3,

    intent: async function(intent, payload = {}, app = 'localhost', options = {}) {
      const parts = intent.split('.');
      if (parts.length < 2) {
        throw new Error("Invalid intent format. Must be 'namespace.action' (e.g. 'ui.TextToSpeech')");
      }
      const [namespace, action] = parts;
      const endpoint = `/intent/${namespace}/${action}?app=${encodeURIComponent(app)}`;

      applyIntentPreferences(payload, options);
      const headers = buildIntentHeaders(payload);

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
        if (!boundary) {
          boundary = detectMultipartBoundary(buffer);
        }
        if (boundary) {
          buffer = processMultipartBuffer(buffer, boundary, onFrame);
        }
        if (done) break;
      }
    },

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

      const boundary = responseText.split(/\r?\n/)[0].trim();
      const rawParts = responseText.split(boundary).filter(p => p.trim() && !p.includes('--\r') && !p.includes('--\n'));

      for (const part of rawParts) {
        const frame = parseMultipartPart(part, false);
        if (frame) {
          const entry = { headers: frame.headers, body: frame.body };
          if (frame.json !== null) entry.json = frame.json;
          parts.push(entry);
        }
      }
      return parts;
    },

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
    XBlobCreate: async function(blobData = {}) {
      const isFdRights = blobData._dataType === 'fd-rights' || blobData.contentEncoding === 'fd-rights';
      const isBase64 = blobData._dataType === 'base64' || blobData.contentEncoding === 'base64';
      const contentEncoding = isFdRights ? 'fd-rights' : (isBase64 ? 'base64' : 'identity');

      const res = await fetch('/blobs', {
        method: 'PUT',
        headers: {
          'Content-Type': blobData.type || 'application/json',
          'Content-Encoding': contentEncoding,
          'Accept-Encoding': 'identity, base64, fd-rights',
          'X-Forwarded-By': getForwardedByHeader()
        },
        body: typeof blobData === 'string' ? blobData : JSON.stringify(blobData)
      });
      if (!res.ok) {
        const fallbackRes = await fetch('/xblob/XBlobCreate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
          body: JSON.stringify(blobData)
        });
        if (!fallbackRes.ok) throw new Error(`XBlobCreate failed: HTTP ${fallbackRes.status}`);
        return fallbackRes.json();
      }
      return res.json();
    },

    XBlobTransfer: async function(blobId, grantee = null) {
      const res = await fetch('/xblob/XBlobTransfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
        body: JSON.stringify({ blobId: blobId, blob: blobId, grantee: grantee })
      });
      if (!res.ok) throw new Error(`XBlobTransfer failed: HTTP ${res.status}`);
      return res.json();
    },

    XBlobGrant: async function(blobId, grantee = null) {
      const res = await fetch('/xblob/XBlobGrant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
        body: JSON.stringify({ blobId: blobId, blob: blobId, grantee: grantee })
      });
      if (!res.ok) throw new Error(`XBlobGrant failed: HTTP ${res.status}`);
      return res.json();
    },

    XBlobUnlink: async function(blobId) {
      const res = await fetch('/xblob/XBlobUnlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
        body: JSON.stringify({ blobId: blobId, blob: blobId })
      });
      if (!res.ok) throw new Error(`XBlobUnlink failed: HTTP ${res.status}`);
      return res.json();
    },

    XBlobBroadcast: async function(blobId, host = null, version = null) {
      const res = await fetch('/xblob/XBlobBroadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
        body: JSON.stringify({ blobId: blobId, blob: blobId, host: host, version: version })
      });
      if (!res.ok) throw new Error(`XBlobBroadcast failed: HTTP ${res.status}`);
      return res.json();
    },

    XBlobRead: async function(blobId) {
      const hexBlob = typeof blobId === 'number' ? `0x${blobId.toString(16)}` : String(blobId);
      const res = await fetch(`/blobs/${hexBlob}`, {
        method: 'GET',
        headers: { 'Accept-Encoding': 'identity, base64, fd-rights', 'X-Forwarded-By': getForwardedByHeader() }
      });
      if (!res.ok) {
        const fallbackRes = await fetch('/xblob/XBlobRead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
          body: JSON.stringify({ blobId: blobId, blob: blobId })
        });
        if (!fallbackRes.ok) throw new Error(`XBlobRead failed: HTTP ${fallbackRes.status}`);
        return fallbackRes.json();
      }
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return res.json();
      }
      const data = await res.text();
      return {
        xblobType: res.headers.get('x-xblob-type') || 'Blob',
        type: contentType,
        contentEncoding: res.headers.get('content-encoding'),
        data: data
      };
    }
  };

  window.xblob.create = window.xblob.XBlobCreate;
  window.xblob.read = window.xblob.XBlobRead;
  window.xblob.transfer = window.xblob.XBlobTransfer;
  window.xblob.grant = window.xblob.XBlobGrant;
  window.xblob.unlink = window.xblob.XBlobUnlink;
  window.xblob.broadcast = window.xblob.XBlobBroadcast;

  // --- window.xaudio ---
  window.xaudio = window.xaudio || {
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
        const ws = new WebSocket(wsUrl, 'message-http');
        this._ws = ws;

        ws.onerror = (errEv) => {
          console.warn(`[xaudio] WebSocket error on ${wsUrl}: ${formatErrorDetails(errEv)}`, errEv);
        };

        ws.onmessage = (event) => {
          try {
            const frame = parseWsAudioEventData(event.data);
            if (!frame) return;
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
        console.warn(`[xaudio] Could not establish /xaudio WebSocket to ${wsUrl}: ${formatErrorDetails(err)}`, err);
        return null;
      }
    },

    XAudioPlay: async function(cookieOrOptions = {}, seqnum = 0, sample = null) {
      const options = normalizePlayOptions(cookieOrOptions, seqnum, sample);
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

    controlStream: async function(options = {}) {
      const isObj = typeof options === 'object' && options !== null;
      const command = typeof options === 'string' ? options : (options.command || 'stop');
      const cookie = isObj ? (options.cookie || options.OutputId || 'default') : 'default';
      const streamId = isObj ? (options.streamId ?? options.stream ?? 1) : 1;
      const app = (isObj && options.app) ? options.app : 'localhost';
      return window.xintent.intent('xaudio.ControlStream', {
        intent: 'xaudio.ControlStream',
        command: command,
        cookie: cookie,
        OutputId: cookie,
        streamId: streamId,
        app: app,
        ...(isObj ? options : {})
      }, app);
    },

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
