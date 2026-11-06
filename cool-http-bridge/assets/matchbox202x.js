(function(window) {
  'use strict';

  if (window.__matchbox202xInitialized) return;
  window.__matchbox202xInitialized = true;

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

  function normalizeBlobHex(id) {
    if (id === null || id === undefined) return null;
    if (typeof id === 'number') return isNaN(id) ? null : `0x${(id >>> 0).toString(16)}`;
    const s = String(id).trim();
    if (!s) return null;
    const num = (s.startsWith('0x') || s.startsWith('0X')) ? parseInt(s, 16) : Number(s);
    return isNaN(num) ? s : `0x${(num >>> 0).toString(16)}`;
  }

  function translateVirtualBlobId(rawId) {
    if (!rawId || !window.xhtml || typeof window.xhtml.getNatInfo !== 'function') return rawId;
    return window.xhtml.getNatInfo('blob', rawId) || rawId;
  }

  function getActiveCardWin() {
    if (window.xhtml && window.xhtml.cardWin) return window.xhtml.cardWin;
    try {
      const params = new URLSearchParams(window.location.search || '');
      const fromUrl = params.get('cardWin');
      if (fromUrl) return fromUrl;
    } catch (_) {}
    return null;
  }

  function applyCardWinHeader(headers) {
    const cardWin = getActiveCardWin();
    if (cardWin) headers['X-Card-Window'] = String(cardWin);
    return headers;
  }

  if (typeof window.fetch === 'function' && !window.__matchboxFetchWrapped) {
    const nativeFetch = window.fetch.bind(window);
    window.__matchboxFetchWrapped = true;
    window.fetch = async function(input, init = {}) {
      let urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
      const isSameOriginApi =
        urlStr.startsWith('/xblob') ||
        urlStr.startsWith('/blobs') ||
        urlStr.startsWith('/intent/') ||
        urlStr.startsWith('/api/');

      if (isSameOriginApi) {
        init = Object.assign({}, init);
        const hdrs = Object.assign({}, init.headers || {});
        const cardWin = getActiveCardWin();
        if (cardWin && !hdrs['X-Card-Window'] && !hdrs['x-card-window']) {
          hdrs['X-Card-Window'] = String(cardWin);
        }
        const attachedBlob = hdrs['X-Attached-Blob-Id'] || hdrs['x-attached-blob-id'];
        if (attachedBlob) {
          const mappedAttached = translateVirtualBlobId(attachedBlob);
          if (hdrs['X-Attached-Blob-Id']) hdrs['X-Attached-Blob-Id'] = String(mappedAttached);
          if (hdrs['x-attached-blob-id']) hdrs['x-attached-blob-id'] = String(mappedAttached);
          if (window.xhtml?.heldBlobs) {
            window.xhtml.heldBlobs.add(normalizeBlobHex(attachedBlob));
          }
        }
        init.headers = hdrs;

        const blobPathMatch = urlStr.match(/^(\/(?:xblob|blobs)\/)(0x[0-9a-fA-F]+|\d+)(\b.*)?$/);
        if (blobPathMatch) {
          const origId = blobPathMatch[2];
          const mappedId = translateVirtualBlobId(origId);
          if (mappedId) {
            urlStr = `${blobPathMatch[1]}${mappedId}${blobPathMatch[3] || ''}`;
            input = urlStr;
          }
        }
      }

      const response = await nativeFetch(input, init);
      try {
        if (
          (urlStr === '/xblob' || urlStr === '/blobs' || urlStr === '/xblob/XBlobCreate') &&
          (init?.method === 'PUT' || init?.method === 'POST')
        ) {
          const createdBlobHeader = response.headers?.get?.('x-blob-id');
          if (createdBlobHeader && window.xhtml?.heldBlobs) {
            const normCreated = normalizeBlobHex(createdBlobHeader);
            window.xhtml.heldBlobs.add(normCreated);
            if (!window.xhtml.blobNatTable.has(normCreated)) {
              window.xhtml.blobNatTable.set(normCreated, normCreated);
            }
          }
        }
      } catch (_) {}
      return response;
    };
  }

  function buildIntentHeaders(payload) {
    const headers = { 'Content-Type': 'application/json' };
    const ctrlHeader = formatControlWordHeader(payload.controlWord);
    if (ctrlHeader) headers['X-Channel-Control'] = ctrlHeader;
    if (payload.Accept) headers['Accept'] = payload.Accept;
    if (payload.Prefer) headers['Prefer'] = payload.Prefer;
    if (payload.txId !== undefined) headers['X-Tx-Id'] = String(payload.txId);
    if (payload.headers && typeof payload.headers === 'object') {
      Object.assign(headers, payload.headers);
    }
    const conn = payload.Connection || payload.connection;
    if (conn) headers['Connection'] = conn;
    headers['X-Forwarded-By'] = getForwardedByHeader(payload['X-Forwarded-By']);
    return applyCardWinHeader(headers);
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
      let trackedTxId = null;

      response.getBytesReceived = () => totalBytesReceived;
      response.getChunkCount = () => chunkCount;
      window.xintent.lastStreamMetrics = {
        getBytesReceived: () => totalBytesReceived,
        getChunkCount: () => chunkCount,
      };

      const wrappedOnFrame = (frame) => {
        if (frame && frame.headers) {
          const txHeader = frame.headers['x-tx-id'];
          if (txHeader && window.xhtml) {
            trackedTxId = Number(txHeader);
            const ctrl = frame.headers['x-channel-control'] || '';
            if (ctrl.includes('FIN') || (frame.json && frame.json.disposition === 'final')) {
              window.xhtml.openChannels.delete(trackedTxId);
            } else {
              window.xhtml.openChannels.set(trackedTxId, {
                txId: trackedTxId,
                onFrame: onFrame,
              });
            }
          }
        }
        if (typeof onFrame === 'function') onFrame(frame);
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
          buffer = processMultipartBuffer(buffer, boundary, wrappedOnFrame);
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
        headers: applyCardWinHeader({
          'Content-Type': blobData.type || 'application/json',
          'Content-Encoding': contentEncoding,
          'Accept-Encoding': 'identity, base64, fd-rights',
          'X-Forwarded-By': getForwardedByHeader()
        }),
        body: typeof blobData === 'string' ? blobData : JSON.stringify(blobData)
      });
      let out;
      if (!res.ok) {
        const fallbackRes = await fetch('/xblob/XBlobCreate', {
          method: 'POST',
          headers: applyCardWinHeader({ 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() }),
          body: JSON.stringify(blobData)
        });
        if (!fallbackRes.ok) throw new Error(`XBlobCreate failed: HTTP ${fallbackRes.status}`);
        out = await fallbackRes.json();
      } else {
        out = await res.json();
      }
      const createdId = out?.blobId || out?.blob;
      if (createdId && window.xhtml?.heldBlobs) {
        window.xhtml.heldBlobs.add(String(createdId));
      }
      return out;
    },

    XBlobTransfer: async function(blobId, grantee = null) {
      const res = await fetch('/xblob/XBlobTransfer', {
        method: 'POST',
        headers: applyCardWinHeader({ 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() }),
        body: JSON.stringify({ blobId: blobId, blob: blobId, grantee: grantee })
      });
      if (!res.ok) throw new Error(`XBlobTransfer failed: HTTP ${res.status}`);
      if (window.xhtml?.heldBlobs) window.xhtml.heldBlobs.delete(String(blobId));
      return res.json();
    },

    XBlobGrant: async function(blobId, grantee = null) {
      const res = await fetch('/xblob/XBlobGrant', {
        method: 'POST',
        headers: applyCardWinHeader({ 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() }),
        body: JSON.stringify({ blobId: blobId, blob: blobId, grantee: grantee })
      });
      if (!res.ok) throw new Error(`XBlobGrant failed: HTTP ${res.status}`);
      return res.json();
    },

    XBlobUnlink: async function(blobId) {
      const res = await fetch('/xblob/XBlobUnlink', {
        method: 'POST',
        headers: applyCardWinHeader({ 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() }),
        body: JSON.stringify({ blobId: blobId, blob: blobId })
      });
      if (!res.ok) throw new Error(`XBlobUnlink failed: HTTP ${res.status}`);
      if (window.xhtml?.heldBlobs) window.xhtml.heldBlobs.delete(String(blobId));
      return res.json();
    },

    XBlobSoftLink: async function(blobId, grantee = null) {
      const res = await fetch('/xblob/XBlobSoftLink', {
        method: 'POST',
        headers: applyCardWinHeader({ 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() }),
        body: JSON.stringify({ blobId: blobId, blob: blobId, grantee: grantee })
      });
      if (!res.ok) throw new Error(`XBlobSoftLink failed: HTTP ${res.status}`);
      if (window.xhtml?.softLinkedBlobs) window.xhtml.softLinkedBlobs.add(String(blobId));
      return res.json();
    },

    XBlobSoftUnlink: async function(blobId, grantee = null) {
      const res = await fetch('/xblob/XBlobSoftUnlink', {
        method: 'POST',
        headers: applyCardWinHeader({ 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() }),
        body: JSON.stringify({ blobId: blobId, blob: blobId, grantee: grantee })
      });
      if (!res.ok) throw new Error(`XBlobSoftUnlink failed: HTTP ${res.status}`);
      if (window.xhtml?.softLinkedBlobs) window.xhtml.softLinkedBlobs.delete(String(blobId));
      return res.json();
    },

    XBlobBroadcast: async function(blobId, host = null, version = null) {
      const res = await fetch('/xblob/XBlobBroadcast', {
        method: 'POST',
        headers: applyCardWinHeader({ 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() }),
        body: JSON.stringify({ blobId: blobId, blob: blobId, host: host, version: version })
      });
      if (!res.ok) throw new Error(`XBlobBroadcast failed: HTTP ${res.status}`);
      return res.json();
    },

    XBlobRead: async function(blobId) {
      const hexBlob = typeof blobId === 'number' ? `0x${blobId.toString(16)}` : String(blobId);
      const res = await fetch(`/blobs/${hexBlob}`, {
        method: 'GET',
        headers: applyCardWinHeader({ 'Accept-Encoding': 'identity, base64, fd-rights', 'X-Forwarded-By': getForwardedByHeader() })
      });
      if (!res.ok) {
        const fallbackRes = await fetch('/xblob/XBlobRead', {
          method: 'POST',
          headers: applyCardWinHeader({ 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() }),
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
  window.xblob.softLink = window.xblob.XBlobSoftLink;
  window.xblob.softUnlink = window.xblob.XBlobSoftUnlink;
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

  function inferCardIdentity() {
    let cardApp = 'xhtml-card';
    let cardId = 'main';
    try {
      const parts = (window.location.pathname || '').split('/').filter(Boolean);
      if (parts[0] === 'apps' && parts[1]) {
        cardApp = parts[1];
        cardId = parts[2] || 'main';
      }
    } catch (_) {}
    return { cardApp, cardId };
  }

  function snapshotWebStorage(storageObj) {
    const out = {};
    try {
      if (!storageObj) return out;
      for (let i = 0; i < storageObj.length; i++) {
        const k = storageObj.key(i);
        if (k !== null) out[k] = storageObj.getItem(k);
      }
    } catch (_) {}
    return out;
  }

  function restoreWebStorage(storageObj, map) {
    try {
      if (!storageObj || !map || typeof map !== 'object') return;
      for (const [k, v] of Object.entries(map)) {
        storageObj.setItem(k, String(v));
      }
    } catch (_) {}
  }

  function snapshotDomInputs() {
    const inputs = {};
    try {
      if (typeof document === 'undefined' || !document.querySelectorAll) return inputs;
      const els = Array.from(document.querySelectorAll('input, select, textarea')).filter(
        (el) => !(el.closest && el.closest('[data-xhtml-runtime-ui="true"]'))
      );
      els.forEach((el, idx) => {
        const key = el.id ? `#${el.id}` : (el.name ? `[name="${el.name}"]` : `input:${idx}`);
        if (el.type === 'checkbox' || el.type === 'radio') {
          inputs[key] = { checked: Boolean(el.checked), value: el.value };
        } else if (el.type !== 'file') {
          inputs[key] = el.value;
        }
      });
    } catch (_) {}
    return inputs;
  }

  function restoreDomInputs(inputs) {
    try {
      if (typeof document === 'undefined' || !inputs || typeof inputs !== 'object') return;
      if (inputs['#intent-select'] !== undefined) {
        const intentEl = document.querySelector('#intent-select');
        if (intentEl && intentEl.value !== String(inputs['#intent-select'])) {
          intentEl.value = String(inputs['#intent-select']);
          try { intentEl.dispatchEvent(new Event('change')); } catch (_) {}
        }
      }
      for (const [selector, val] of Object.entries(inputs)) {
        if (selector.startsWith('input:') || selector === '#intent-select') continue;
        const el = document.querySelector(selector);
        if (!el) continue;
        if (val && typeof val === 'object' && 'checked' in val) {
          el.checked = Boolean(val.checked);
        } else {
          el.value = String(val ?? '');
        }
      }
    } catch (_) {}
  }

  // --- window.xhtml ---
  const initialIdentity = inferCardIdentity();
  function parseNatArgs(blobOrKind, id) {
    if (id === undefined) {
      return { kind: 'blob', id: blobOrKind };
    }
    const isChannel =
      blobOrKind === 'channel' ||
      blobOrKind === 'xchannel' ||
      blobOrKind === window.xintent;
    return { kind: isChannel ? 'channel' : 'blob', id };
  }

  const existingXhtml = window.xhtml || {};
  window.xhtml = Object.assign(existingXhtml, {
    cardWin: getActiveCardWin() || existingXhtml.cardWin || null,
    cardApp: initialIdentity.cardApp || existingXhtml.cardApp,
    cardId: initialIdentity.cardId || existingXhtml.cardId,
    heldBlobs: existingXhtml.heldBlobs instanceof Set ? existingXhtml.heldBlobs : new Set(),
    softLinkedBlobs: existingXhtml.softLinkedBlobs instanceof Set ? existingXhtml.softLinkedBlobs : new Set(),
    openChannels: existingXhtml.openChannels instanceof Map ? existingXhtml.openChannels : new Map(),
    blobNatTable: existingXhtml.blobNatTable instanceof Map ? existingXhtml.blobNatTable : new Map(),
    channelNatTable: existingXhtml.channelNatTable instanceof Map ? existingXhtml.channelNatTable : new Map(),
    _remapWaiters: existingXhtml._remapWaiters instanceof Map ? existingXhtml._remapWaiters : new Map(),
    _remappedHistory: existingXhtml._remappedHistory instanceof Map ? existingXhtml._remappedHistory : new Map(),
    _migrateCompleteWaiters: Array.isArray(existingXhtml._migrateCompleteWaiters) ? existingXhtml._migrateCompleteWaiters : [],
    onfreeze: existingXhtml.onfreeze || null,
    onthaw: existingXhtml.onthaw || null,
    _cardWs: existingXhtml._cardWs || null,

    getNatInfo: function(blobOrKind, id) {
      const parsed = parseNatArgs(blobOrKind, id);
      if (parsed.kind === 'channel') {
        const chKey = Number(parsed.id);
        return this.channelNatTable.get(chKey) ?? this.channelNatTable.get(String(parsed.id)) ?? chKey;
      }
      const normKey = normalizeBlobHex(parsed.id);
      if (!normKey) return parsed.id;
      return this.blobNatTable.get(normKey) || this.blobNatTable.get(String(parsed.id)) || normKey;
    },

    whenRemapped: function(blobOrKind, id) {
      const parsed = parseNatArgs(blobOrKind, id);
      const key = parsed.kind === 'channel'
        ? `channel:${Number(parsed.id)}`
        : `blob:${normalizeBlobHex(parsed.id)}`;

      if (this._remappedHistory.has(key)) {
        return Promise.resolve(this._remappedHistory.get(key));
      }
      if (parsed.kind === 'blob') {
        const normKey = normalizeBlobHex(parsed.id);
        const existingLocal = this.blobNatTable.get(normKey);
        if (existingLocal && existingLocal !== normKey) {
          return Promise.resolve(existingLocal);
        }
      } else {
        const chKey = Number(parsed.id);
        const existingLocalCh = this.channelNatTable.get(chKey);
        if (existingLocalCh !== undefined && existingLocalCh !== chKey) {
          return Promise.resolve(existingLocalCh);
        }
      }
      return new Promise((resolve) => {
        const list = this._remapWaiters.get(key) || [];
        list.push(resolve);
        this._remapWaiters.set(key, list);
      });
    },

    _recordRemap: function(kind, virtualId, localId) {
      if (kind === 'channel') {
        const vTx = Number(virtualId);
        const lTx = Number(localId);
        if (isNaN(vTx) || isNaN(lTx)) return;
        this.channelNatTable.set(vTx, lTx);
        const key = `channel:${vTx}`;
        this._remappedHistory.set(key, lTx);
        const waiters = this._remapWaiters.get(key) || [];
        this._remapWaiters.delete(key);
        waiters.forEach((fn) => { try { fn(lTx); } catch (_) {} });
        return;
      }
      const vHex = normalizeBlobHex(virtualId);
      const lHex = normalizeBlobHex(localId);
      if (!vHex || !lHex) return;
      const existingLocal = this.blobNatTable.get(vHex);
      if (existingLocal && existingLocal !== vHex && lHex === vHex) {
        this.heldBlobs.add(vHex);
        return;
      }
      this.blobNatTable.set(vHex, lHex);
      this.heldBlobs.add(vHex);
      if (lHex !== vHex) {
        const key = `blob:${vHex}`;
        this._remappedHistory.set(key, lHex);
        const waiters = this._remapWaiters.get(key) || [];
        this._remapWaiters.delete(key);
        waiters.forEach((fn) => { try { fn(lHex); } catch (_) {} });
        if (!this._isHydrating && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          try {
            window.dispatchEvent(
              new CustomEvent('xhtml:blob-transferred', {
                detail: { blobId: vHex, virtualBlobId: vHex, nattedBlobId: lHex, localBlobId: lHex },
              })
            );
          } catch (_) {}
        }
      }
    },

    ensureCardSession: async function(options = {}) {
      const existing = getActiveCardWin();
      if (existing) {
        this.cardWin = existing;
      }
      const appId = options.cardApp || this.cardApp || 'xhtml-card';
      const cardId = options.cardId || this.cardId || 'main';
      try {
        const reqBody = {
          appId,
          cardId,
          cardWin: this.cardWin || undefined,
        };
        if (!options.skipNatUpload) {
          reqBody.blobNatTable = Object.fromEntries(this.blobNatTable);
          reqBody.channelNatTable = Object.fromEntries(this.channelNatTable);
        }
        const res = await fetch('/api/card-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': getForwardedByHeader() },
          body: JSON.stringify(reqBody)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.cardWin) this.cardWin = data.cardWin;
          if (data.runtimeHost) this.runtimeHost = data.runtimeHost;
          if (data.browserDisplay) this.browserDisplay = data.browserDisplay;
          if (data.blobNatTable && typeof data.blobNatTable === 'object') {
            for (const [k, v] of Object.entries(data.blobNatTable)) {
              this._recordRemap('blob', k, v);
            }
          }
          if (data.channelNatTable && typeof data.channelNatTable === 'object') {
            for (const [k, v] of Object.entries(data.channelNatTable)) {
              this._recordRemap('channel', k, v);
            }
          }
        }
      } catch (_) {}
      this.connectCardWs();
      if (typeof this.refreshRuntimeMigrateBar === 'function') {
        try { this.refreshRuntimeMigrateBar(); } catch (_) {}
      }
      return this.cardWin;
    },

    connectCardWs: function(reattachTxIds = []) {
      if (!this.cardWin) return null;
      if (
        this._cardWs &&
        (this._cardWs.readyState === WebSocket.OPEN || this._cardWs.readyState === WebSocket.CONNECTING) &&
        (!Array.isArray(reattachTxIds) || reattachTxIds.length === 0)
      ) {
        return this._cardWs;
      }
      const wsProtocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
      const txParam = Array.isArray(reattachTxIds) && reattachTxIds.length > 0
        ? `&reattachTxIds=${encodeURIComponent(reattachTxIds.join(','))}`
        : '';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws?cardWin=${encodeURIComponent(this.cardWin)}&appId=${encodeURIComponent(this.cardApp)}&cardId=${encodeURIComponent(this.cardId)}${txParam}`;
      try {
        const ws = new WebSocket(wsUrl, 'message-http');
        this._cardWs = ws;
        ws.onmessage = async (event) => {
          try {
            const frame = parseWsAudioEventData(event.data);
            if (!frame) return;
            const evName = frame.event || frame.intent;
            if (evName === 'sys.XBlobTransferred') {
              const virtId = frame.blobId || frame.virtualBlobId;
              const locId = frame.dataBlob || frame.nattedBlobId || frame.localBlobId;
              if (virtId && locId) {
                this._recordRemap('blob', virtId, locId);
              }
            } else if (evName === 'sys.ChannelRedirect') {
              const vTx = frame.cardTxId ?? frame.txId ?? frame.channel;
              const lTx = frame.localChannelId ?? frame.txId ?? frame.channel;
              if (vTx !== undefined && lTx !== undefined) {
                this._recordRemap('channel', vTx, lTx);
              }
            } else if (evName === 'sys.LiveMigrateComplete') {
              const waiters = this._migrateCompleteWaiters.splice(0);
              waiters.forEach((fn) => { try { fn(frame); } catch (_) {} });
            } else if (evName === 'xhtml.RequestSnapshot') {
              const snap = await this.serializeState();
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  event: 'xhtml.SnapshotResponse',
                  cardWin: this.cardWin,
                  snapshot: snap,
                }));
              }
              return;
            }

            const txId = Number(frame.txId || frame.channel || 0);
            if (txId && this.openChannels.has(txId)) {
              const ch = this.openChannels.get(txId);
              if (typeof ch.onFrame === 'function') {
                ch.onFrame({ headers: { 'x-tx-id': String(txId) }, json: frame, body: JSON.stringify(frame) });
              }
              if ((frame.controlWord & 2) !== 0 || frame.disposition === 'final') {
                this.openChannels.delete(txId);
              }
            }
            if (typeof this.onevent === 'function') {
              this.onevent(frame);
            }
          } catch (_) {}
        };
        return ws;
      } catch (_) {
        return null;
      }
    },

    serializeState: async function() {
      await this.ensureCardSession();
      let customState = null;
      if (typeof this.onfreeze === 'function') {
        try {
          customState = await this.onfreeze();
        } catch (err) {
          console.warn('[xhtml] onfreeze hook error:', err);
        }
      }
      const blobNatObj = {};
      for (const [k, v] of this.blobNatTable.entries()) {
        blobNatObj[k] = v;
      }
      const channelNatObj = {};
      for (const [k, v] of this.channelNatTable.entries()) {
        channelNatObj[String(k)] = v;
      }
      return {
        version: '0.1',
        cardApp: this.cardApp,
        cardId: this.cardId,
        cardWin: this.cardWin,
        url: window.location ? window.location.href : '',
        timestamp: Date.now(),
        storage: {
          localStorage: snapshotWebStorage(window.localStorage),
          sessionStorage: snapshotWebStorage(window.sessionStorage),
        },
        domState: {
          scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
          inputs: snapshotDomInputs(),
        },
        heldBlobs: Array.from(this.heldBlobs),
        softLinkedBlobs: Array.from(this.softLinkedBlobs),
        openChannels: Array.from(this.openChannels.values()).map((ch) => ({
          txId: ch.txId,
          intent: ch.intent || null,
          app: ch.app || null,
        })),
        natTables: {
          blobNat: blobNatObj,
          channelNat: channelNatObj,
        },
        customState,
      };
    },

    hydrateState: async function(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return false;
      this._isHydrating = true;
      if (snapshot.cardApp) this.cardApp = snapshot.cardApp;
      if (snapshot.cardId) this.cardId = snapshot.cardId;

      if (snapshot.storage || snapshot.localStorage || snapshot.sessionStorage) {
        restoreWebStorage(window.localStorage, snapshot.storage?.localStorage || snapshot.localStorage);
        restoreWebStorage(window.sessionStorage, snapshot.storage?.sessionStorage || snapshot.sessionStorage);
      }
      if (snapshot.domState) {
        restoreDomInputs(snapshot.domState.inputs);
        setTimeout(() => restoreDomInputs(snapshot.domState.inputs), 150);
        setTimeout(() => restoreDomInputs(snapshot.domState.inputs), 500);
        if (snapshot.domState.scroll && typeof window.scrollTo === 'function') {
          try { window.scrollTo(snapshot.domState.scroll.x || 0, snapshot.domState.scroll.y || 0); } catch (_) {}
        }
      }
      if (Array.isArray(snapshot.heldBlobs)) {
        snapshot.heldBlobs.forEach((b) => {
          const norm = normalizeBlobHex(b);
          this.heldBlobs.add(norm);
          if (!this.blobNatTable.has(norm)) {
            this.blobNatTable.set(norm, norm);
          }
        });
      }
      if (Array.isArray(snapshot.softLinkedBlobs)) {
        snapshot.softLinkedBlobs.forEach((b) => this.softLinkedBlobs.add(normalizeBlobHex(b)));
      }

      const txIdsToReattach = Array.isArray(snapshot.openChannels)
        ? snapshot.openChannels.map((c) => Number(c.txId)).filter((n) => !isNaN(n) && n > 0)
        : [];
      if (txIdsToReattach.length > 0) {
        for (const ch of snapshot.openChannels) {
          if (ch.txId && !this.openChannels.has(Number(ch.txId))) {
            this.openChannels.set(Number(ch.txId), { txId: Number(ch.txId), intent: ch.intent, app: ch.app });
          }
        }
      }
      await this.ensureCardSession({ skipNatUpload: true });
      if (snapshot.natTables && (!snapshot.cardWin || snapshot.cardWin === this.cardWin)) {
        if (snapshot.natTables.blobNat && typeof snapshot.natTables.blobNat === 'object') {
          for (const [vId, lId] of Object.entries(snapshot.natTables.blobNat)) {
            const normV = normalizeBlobHex(vId);
            if (!this.blobNatTable.get(normV) || this.blobNatTable.get(normV) === normV) {
              this._recordRemap('blob', vId, lId);
            }
          }
        }
        if (snapshot.natTables.channelNat && typeof snapshot.natTables.channelNat === 'object') {
          for (const [vTx, lTx] of Object.entries(snapshot.natTables.channelNat)) {
            const numV = Number(vTx);
            if (!this.channelNatTable.has(numV) || this.channelNatTable.get(numV) === numV) {
              this._recordRemap('channel', vTx, lTx);
            }
          }
        }
      }
      this.connectCardWs(txIdsToReattach);

      if (typeof this.onthaw === 'function') {
        try {
          await this.onthaw(snapshot.customState, snapshot);
        } catch (err) {
          console.warn('[xhtml] onthaw hook error:', err);
        }
      }
      this._isHydrating = false;
      if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        try {
          window.dispatchEvent(new CustomEvent('xhtml:thaw', { detail: snapshot }));
          if (this.blobNatTable.size > 0) {
            window.dispatchEvent(new CustomEvent('xhtml:blob-transferred', { detail: Object.fromEntries(this.blobNatTable) }));
          }
        } catch (_) {}
      }
      return true;
    },

    loadCard: async function(cardApp, cardId = 'index', targetApp = 'cool-xhtml-runtime', options = {}) {
      const loadPayload = {
        intent: 'xhtml.LoadCard',
        app: targetApp,
        cardApp: cardApp,
        cardId: cardId,
        controlWord: 1,
        ...options,
      };
      const res = await window.xintent.intent('xhtml.LoadCard', loadPayload, targetApp);
      const parts = typeof res.parseMultipart === 'function' ? await res.parseMultipart() : [];
      return parts[0]?.json || { status: res.ok ? 'ok' : 'error', cardApp, cardId };
    },

    liveMigrate: async function(targetApp = 'user-desktop:cool-xhtml-runtime', options = {}) {
      await this.ensureCardSession();
      const oldCardWin = this.cardWin;

      // Step 1: Send sys.BeginLiveMigrate to local busmaster; busmaster holds mail & drains channels until sys.BeginLiveMigrateResponse
      const beginRes = await window.xintent.intent(
        'sys.BeginLiveMigrate',
        {
          intent: 'sys.BeginLiveMigrate',
          cardWin: oldCardWin,
          oldCardWin: oldCardWin,
          controlWord: 1,
        },
        'xbus-daemon'
      );
      const beginParts = typeof beginRes.parseMultipart === 'function' ? await beginRes.parseMultipart() : [];
      const beginAck = beginParts[0]?.json || { status: 'ok' };

      // Step 2: Freeze process, grab current state, and migrate state with sys.LiveMigrate to remote XHTML runtime with Connection: keep-alive
      const snapshot = await this.serializeState();
      const created = await window.xblob.XBlobCreate({
        xblobType: 'Blob',
        type: 'application/json',
        name: `${this.cardApp}-${this.cardId}.xhtml-snapshot.json`,
        data: snapshot,
      });
      const stateBlobId = created.blobId || created.blob;
      if (this.heldBlobs) {
        this.heldBlobs.delete(normalizeBlobHex(stateBlobId));
        this.heldBlobs.delete(String(stateBlobId));
      }

      const migrateIntentName = options.intent || 'sys.LiveMigrate';
      const migratePayload = {
        intent: migrateIntentName,
        app: targetApp,
        cardApp: this.cardApp,
        cardId: this.cardId,
        oldCardWin: oldCardWin,
        dataBlob: stateBlobId,
        Connection: 'keep-alive',
        deferCommit: true,
        controlWord: 1,
        ...options,
      };

      const migrateRes = await window.xintent.intent(migrateIntentName, migratePayload, targetApp);
      const migrateParts = typeof migrateRes.parseMultipart === 'function' ? await migrateRes.parseMultipart() : [];
      const migrateResponse = migrateParts[0]?.json || { status: migrateRes.ok ? 'ok' : 'error' };
      const newCardWin = migrateResponse.remoteWin || migrateResponse.newCardWin;
      const remoteRuntimeWin = migrateResponse.remoteRuntimeWin || null;

      // Step 3 & 4: Send sys.LiveMigrateCommit to local X busmaster
      let commitResponse = null;
      if (newCardWin) {
        const commitRes = await window.xintent.intent(
          'sys.LiveMigrateCommit',
          {
            intent: 'sys.LiveMigrateCommit',
            oldCardWin: oldCardWin,
            newCardWin: newCardWin,
            remoteWin: newCardWin,
            remoteRuntimeWin: remoteRuntimeWin,
            stateBlobId: stateBlobId,
            excludeBlobs: [stateBlobId],
            heldBlobs: snapshot.heldBlobs || [],
            openChannels: snapshot.openChannels || [],
            natTables: snapshot.natTables || {},
            controlWord: 1,
          },
          'xbus-daemon'
        );
        const commitParts = typeof commitRes.parseMultipart === 'function' ? await commitRes.parseMultipart() : [];
        commitResponse = commitParts[0]?.json || null;
      }

      const result = {
        ...migrateResponse,
        ...(commitResponse || {}),
        status: 'ok',
        beginLiveMigrate: beginAck,
        oldCardWin,
        newCardWin: newCardWin || migrateResponse.newCardWin,
        remoteWin: newCardWin || migrateResponse.remoteWin,
        stateBlobId,
      };

      if (window.XIntentNative && typeof window.XIntentNative.onCardMigrated === 'function') {
        try { window.XIntentNative.onCardMigrated(); } catch (_) {}
      }
      return result;
    },

    autoHydrateFromUrl: async function() {
      try {
        const params = new URLSearchParams(window.location.search || '');
        const cardWinParam = params.get('cardWin');
        if (cardWinParam) this.cardWin = cardWinParam;
        const migrateBlob = params.get('hydrateBlob') || params.get('migrateBlob') || params.get('migrate');
        if (migrateBlob) {
          this._isHydrating = true;
        }
        if (this.cardWin) {
          await this.ensureCardSession({ skipNatUpload: Boolean(migrateBlob) });
        }
        if (!migrateBlob) {
          if (this.cardWin) {
            setTimeout(async () => {
              try {
                await fetch('/api/card-hydrated', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    'X-Card-Window': String(this.cardWin),
                  },
                  body: JSON.stringify({
                    cardWin: this.cardWin,
                    cardApp: this.cardApp,
                    cardId: this.cardId,
                    loaded: true,
                    localStorage: snapshotWebStorage(window.localStorage),
                    domInputs: snapshotDomInputs(),
                    heldBlobs: Array.from(this.heldBlobs),
                    softLinkedBlobs: Array.from(this.softLinkedBlobs),
                    openChannels: Array.from(this.openChannels.keys()),
                    blobNatTable: Object.fromEntries(this.blobNatTable),
                    channelNatTable: Object.fromEntries(this.channelNatTable),
                  }),
                });
              } catch (_) {}
            }, 600);
          }
          return false;
        }
        const readRes = await window.xblob.XBlobRead(migrateBlob);
        let snapshot = readRes?.blob?.data ?? readRes?.data ?? readRes;
        if (typeof snapshot === 'string') {
          try { snapshot = JSON.parse(snapshot); } catch (_) {}
        }
        if (typeof document !== 'undefined' && document.readyState === 'loading') {
          await new Promise((r) => window.addEventListener('DOMContentLoaded', r, { once: true }));
        }
        await this.hydrateState(snapshot);
        this.hydratedSnapshot = snapshot;
        try {
          await window.xblob.XBlobUnlink(migrateBlob);
        } catch (_) {}
        setTimeout(async () => {
          try {
            if (snapshot?.domState?.inputs) {
              restoreDomInputs(snapshot.domState.inputs);
            }
            await fetch('/api/card-hydrated', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(this.cardWin ? { 'X-Card-Window': String(this.cardWin) } : {}),
              },
              body: JSON.stringify({
                cardWin: this.cardWin,
                cardApp: this.cardApp,
                cardId: this.cardId,
                hydrateBlob: migrateBlob,
                localStorage: snapshotWebStorage(window.localStorage),
                domInputs: snapshotDomInputs(),
                heldBlobs: Array.from(this.heldBlobs),
                softLinkedBlobs: Array.from(this.softLinkedBlobs),
                openChannels: Array.from(this.openChannels.keys()),
                blobNatTable: Object.fromEntries(this.blobNatTable),
                channelNatTable: Object.fromEntries(this.channelNatTable),
              }),
            });
          } catch (_) {}
        }, 400);
        return true;
      } catch (err) {
        console.warn('[xhtml] autoHydrateFromUrl warning:', err);
        return false;
      }
    },

    discoverRuntimeHosts: async function() {
      const hosts = [];
      const seen = new Set();
      try {
        const tags = await window.xintent.getTags();
        const providers = [
          ...((tags && tags.intents && tags.intents['sys.LiveMigrate']) || []),
          ...((tags && tags.intents && tags.intents['xhtml.LiveMigrate']) || []),
        ];
        for (const p of providers) {
          if (typeof p === 'string' && p.includes(':')) {
            const host = p.split(':')[0].trim();
            if (host && !seen.has(host)) {
              seen.add(host);
              hosts.push(host);
            }
          }
        }
      } catch (_) {}
      return hosts;
    },

    refreshRuntimeMigrateBar: async function() {
      if (typeof document === 'undefined') return;
      const hostBadge = document.getElementById('xhtml-runtime-current-host');
      const selectEl = document.getElementById('xhtml-migrate-host-select');
      const inputEl = document.getElementById('xhtml-migrate-host-input');
      const datalistEl = document.getElementById('xhtml-migrate-host-datalist');
      if (hostBadge) {
        const hostStr = this.runtimeHost || 'local';
        const winStr = this.cardWin || 'unassigned';
        hostBadge.textContent = `Host: ${hostStr} | Win: ${winStr}`;
        hostBadge.dataset.runtimeHost = String(this.runtimeHost || '');
        hostBadge.dataset.cardWin = String(this.cardWin || '');
      }
      const hosts = await this.discoverRuntimeHosts();
      if (selectEl) {
        const prevVal = selectEl.value || (inputEl && inputEl.value) || '';
        selectEl.innerHTML = '';
        for (const h of hosts) {
          const opt = document.createElement('option');
          opt.value = h;
          opt.textContent = this.runtimeHost && h === this.runtimeHost ? `${h} (current)` : h;
          selectEl.appendChild(opt);
        }
        const remoteHost = hosts.find((h) => !this.runtimeHost || h !== this.runtimeHost) || hosts[0] || '';
        const chosen = (prevVal && hosts.includes(prevVal)) ? prevVal : remoteHost;
        if (chosen) {
          selectEl.value = chosen;
          if (inputEl && !inputEl.dataset.userEdited) {
            inputEl.value = chosen;
          }
        }
      }
      if (datalistEl) {
        datalistEl.innerHTML = '';
        for (const h of hosts) {
          const opt = document.createElement('option');
          opt.value = h;
          datalistEl.appendChild(opt);
        }
      }
    },

    mountRuntimeMigrateBar: function() {
      if (typeof document === 'undefined' || !document.body) return;
      if (document.getElementById('xhtml-runtime-migrate-bar')) {
        this.refreshRuntimeMigrateBar();
        return;
      }

      const bar = document.createElement('div');
      bar.id = 'xhtml-runtime-migrate-bar';
      bar.setAttribute('data-xhtml-runtime-ui', 'true');
      bar.style.cssText = [
        'width: 100%',
        'max-width: 960px',
        'margin: 0 auto 10px auto',
        'padding: 6px 12px',
        'background: #14191f',
        'border: 1px solid #2e4052',
        'border-radius: 6px',
        'color: #d8dee9',
        'font-family: monospace',
        'font-size: 12px',
        'display: flex',
        'align-items: center',
        'justify-content: space-between',
        'gap: 10px',
        'flex-wrap: wrap',
        'box-sizing: border-box',
        'z-index: 9999',
      ].join(';');

      const leftGroup = document.createElement('div');
      leftGroup.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

      const titleBadge = document.createElement('span');
      titleBadge.style.cssText = 'color:#8be9fd;font-weight:bold;';
      titleBadge.textContent = `XHTML Runtime [${this.cardApp}/${this.cardId}]`;

      const hostBadge = document.createElement('span');
      hostBadge.id = 'xhtml-runtime-current-host';
      hostBadge.style.cssText = 'background:#1e2630;border:1px solid #3b4b5c;border-radius:4px;padding:2px 6px;color:#50fa7b;';
      hostBadge.textContent = `Host: ${this.runtimeHost || 'local'} | Win: ${this.cardWin || 'unassigned'}`;

      leftGroup.appendChild(titleBadge);
      leftGroup.appendChild(hostBadge);

      const rightGroup = document.createElement('div');
      rightGroup.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;';

      const labelEl = document.createElement('label');
      labelEl.htmlFor = 'xhtml-migrate-host-input';
      labelEl.textContent = 'Target Host:';
      labelEl.style.cssText = 'color:#a6adc8;';

      const selectEl = document.createElement('select');
      selectEl.id = 'xhtml-migrate-host-select';
      selectEl.setAttribute('data-xhtml-runtime-ui', 'true');
      selectEl.style.cssText = 'background:#0d1117;color:#f8f8f2;border:1px solid #3b4b5c;border-radius:4px;padding:3px 6px;font-family:monospace;font-size:12px;';

      const inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.id = 'xhtml-migrate-host-input';
      inputEl.setAttribute('list', 'xhtml-migrate-host-datalist');
      inputEl.setAttribute('data-xhtml-runtime-ui', 'true');
      inputEl.placeholder = 'type or select hostname...';
      inputEl.style.cssText = 'background:#0d1117;color:#f8f8f2;border:1px solid #3b4b5c;border-radius:4px;padding:3px 8px;font-family:monospace;font-size:12px;width:155px;';

      const datalistEl = document.createElement('datalist');
      datalistEl.id = 'xhtml-migrate-host-datalist';

      const migrateBtn = document.createElement('button');
      migrateBtn.type = 'button';
      migrateBtn.id = 'xhtml-migrate-btn';
      migrateBtn.setAttribute('data-xhtml-runtime-ui', 'true');
      migrateBtn.textContent = 'Migrate';
      migrateBtn.style.cssText = 'background:#50fa7b;color:#0b1116;border:none;border-radius:4px;padding:4px 10px;font-family:monospace;font-size:12px;font-weight:bold;cursor:pointer;';

      const statusSpan = document.createElement('span');
      statusSpan.id = 'xhtml-migrate-status';
      statusSpan.setAttribute('data-xhtml-runtime-ui', 'true');
      statusSpan.style.cssText = 'color:#f1fa8c;font-size:11px;';

      selectEl.addEventListener('change', () => {
        inputEl.value = selectEl.value;
      });
      inputEl.addEventListener('input', () => {
        inputEl.dataset.userEdited = '1';
      });

      const triggerMigrate = async () => {
        const rawHost = (inputEl.value || selectEl.value || '').trim();
        if (!rawHost) {
          statusSpan.textContent = 'Enter or select a hostname';
          return;
        }
        const targetRuntime = rawHost.includes(':') ? rawHost : `${rawHost}:cool-xhtml-runtime`;
        statusSpan.textContent = `Migrating to ${rawHost}...`;
        migrateBtn.disabled = true;
        try {
          const res = await this.liveMigrate(targetRuntime);
          statusSpan.textContent = `Migrated -> ${res?.newCardWin || res?.remoteWin || 'ok'}`;
        } catch (err) {
          statusSpan.textContent = `Error: ${err.message}`;
        } finally {
          migrateBtn.disabled = false;
        }
      };

      migrateBtn.addEventListener('click', triggerMigrate);
      inputEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          triggerMigrate();
        }
      });

      rightGroup.appendChild(labelEl);
      rightGroup.appendChild(selectEl);
      rightGroup.appendChild(inputEl);
      rightGroup.appendChild(datalistEl);
      rightGroup.appendChild(migrateBtn);
      rightGroup.appendChild(statusSpan);

      bar.appendChild(leftGroup);
      bar.appendChild(rightGroup);
      document.body.insertBefore(bar, document.body.firstChild);

      this.refreshRuntimeMigrateBar();
    }
  });

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', () => {
        window.xhtml.mountRuntimeMigrateBar();
      });
    } else {
      window.xhtml.mountRuntimeMigrateBar();
    }
  }

  if (
    typeof window.location !== 'undefined' &&
    window.location.search &&
    (window.location.search.includes('migrate') ||
      window.location.search.includes('hydrate') ||
      window.location.search.includes('cardWin'))
  ) {
    window.xhtml.autoHydrateFromUrl();
  }
})(window);
