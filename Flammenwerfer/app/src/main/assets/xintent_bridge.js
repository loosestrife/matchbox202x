(function() {
  if (window.xintent && typeof window.xintent.intent === 'function' && window.xaudio) return;

  function callNative(methodName, arg) {
    var nativeObj = window.XIntentNative;
    if (nativeObj && typeof nativeObj[methodName] === 'function') {
      return arg !== undefined ? nativeObj[methodName](arg) : nativeObj[methodName]();
    }
    return undefined;
  }

  function logNative(msg) {
    console.log(msg);
    callNative('logMessage', msg);
  }

  function jsonResponse(rawBody, status) {
    return new Response(rawBody, {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function getRoutingMode(modeGetter, legacyFlagGetter, localModeName) {
    return callNative(modeGetter) || (callNative(legacyFlagGetter) ? localModeName : 'normal');
  }

  function parseHeaderLines(headerText) {
    var headers = {};
    var lines = (headerText || '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var colon = lines[i].indexOf(':');
      if (colon !== -1) {
        headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
      }
    }
    return headers;
  }

  var LOCAL_INTENT_SPECS = {
    'xaudio.PlaySoundBlob': { modeFn: 'getAudioMode', localMode: 'doLocalAudioCapture', remoteMode: 'doRemoteAudioCapture', icon: '🔊', nativeFn: 'handleLocalAudioPlay', target: 'phone speaker' },
    'xaudio.PlayStream': { modeFn: 'getAudioMode', localMode: 'doLocalAudioCapture', remoteMode: 'doRemoteAudioCapture', icon: '🔊', nativeFn: 'handleLocalAudioPlay', target: 'phone speaker' },
    'xaudio.ControlStream': { modeFn: 'getAudioMode', localMode: 'doLocalAudioCapture', remoteMode: 'doRemoteAudioCapture', icon: '🛑', nativeFn: 'handleLocalAudioControl', target: 'phone speaker' },
    'ui.TextToSpeech': { modeFn: 'getTtsMode', localMode: 'doLocalTtsCapture', remoteMode: 'doRemoteTtsCapture', icon: '🗣️', nativeFn: 'handleLocalTts', target: 'Android speech engine' },
    'ui.Copy': { modeFn: 'getClipboardMode', localMode: 'doLocalClipboardCapture', remoteMode: 'doRemoteClipboardCapture', icon: '📋', nativeFn: 'handleLocalCopy', target: 'Android clipboard' },
    'ui.Paste': { modeFn: 'getClipboardMode', localMode: 'doLocalClipboardCapture', remoteMode: 'doRemoteClipboardCapture', icon: '📋', nativeFn: 'handleLocalPaste', target: 'Android clipboard', noArg: true },
    'fs.SendTo': { modeFn: 'getFsMode', localMode: 'doLocalFsCapture', remoteMode: 'doRemoteFsCapture', icon: '📁', nativeFn: 'handleLocalSendTo', target: 'Android file saver', fsFallback: true },
    'fs.SaveAs': { modeFn: 'getFsMode', localMode: 'doLocalFsCapture', remoteMode: 'doRemoteFsCapture', icon: '📁', nativeFn: 'handleLocalSendTo', target: 'Android file saver', fsFallback: true }
  };

  function resolveIntentRouting(intentName, payload, targetApp) {
    var payloadStr = JSON.stringify(payload || {});
    var defaultRemote = window.xintent.getDefaultRemoteDevice();

    if (intentName === 'fs.PickFile') {
      var fsMode = window.xintent.getFsMode();
      var useLocalPick = fsMode === 'doLocalFsCapture' || targetApp === 'flammenwerfer-phone' || (window.XIntentNative && fsMode !== 'doRemoteFsCapture');
      if (useLocalPick) {
        logNative('[XIntent Local 📁] Handling fs.PickFile locally via Android document picker');
        return { handled: true, response: jsonResponse(callNative('handleLocalPickFile', payloadStr)) };
      }
      return { handled: false, targetApp: targetApp || (payload && payload.app) || defaultRemote };
    }

    var spec = LOCAL_INTENT_SPECS[intentName];
    if (!spec) return { handled: false, targetApp: targetApp };

    var currentMode = window.xintent[spec.modeFn]();
    if (currentMode === spec.localMode) {
      logNative('[XIntent Local ' + spec.icon + '] Handling ' + intentName + ' locally on ' + spec.target);
      var rawRes = spec.noArg ? callNative(spec.nativeFn) : callNative(spec.nativeFn, payloadStr);
      return { handled: true, response: jsonResponse(rawRes) };
    }
    var resolvedTarget = spec.fsFallback
      ? (targetApp || (payload && payload.app) || defaultRemote)
      : (currentMode === spec.remoteMode ? defaultRemote : targetApp);
    return { handled: false, targetApp: resolvedTarget };
  }

  function buildIntentHeaders(payload, controlWord) {
    var headers = {
      'Content-Type': 'application/json',
      'Accept': (payload && payload.Accept) ? payload.Accept : '*/*',
      'X-Forwarded-By': 'flammenwerfer-web-card'
    };
    if (window.xhtml && window.xhtml.cardWin) {
      headers['X-Card-Window'] = String(window.xhtml.cardWin);
    }
    if (payload && payload.txId !== undefined) {
      headers['X-Tx-Id'] = String(payload.txId);
    }
    if (controlWord !== undefined) {
      var ctrlStrings = [];
      if (controlWord & 1) ctrlStrings.push('SYN');
      if (controlWord & 2) ctrlStrings.push('FIN');
      if (ctrlStrings.length > 0) headers['X-Channel-Control'] = ctrlStrings.join(',');
    }
    if (payload && payload.headers && typeof payload.headers === 'object') {
      Object.assign(headers, payload.headers);
    }
    var conn = payload && (payload.Connection || payload.connection);
    if (conn) headers['Connection'] = conn;
    return headers;
  }

  function buildIntentRequest(intentName, payload, resolvedTargetApp) {
    var parts = (intentName || '').split('.');
    var namespace = parts[0] || 'ui';
    var action = parts[1] || intentName;
    var app = resolvedTargetApp || (payload && payload.app) || 'localhost';
    var url = '/intent/' + namespace + '/' + action + '?app=' + encodeURIComponent(app);

    var bodyData = Object.assign({}, payload || {}, { intent: intentName, app: app });
    var isXAudio = (intentName || '').indexOf('xaudio.') === 0 || (intentName || '').indexOf('XAudio') === 0;
    if (bodyData.controlWord === undefined && (bodyData.Accept || isXAudio)) {
      bodyData.controlWord = 1;
    }
    return { url: url, app: app, headers: buildIntentHeaders(payload, bodyData.controlWord), bodyData: bodyData };
  }

  function attachResponseHelpers(response, intentName) {
    response.readMultipartStream = (onFrame) => window.xintent.readMultipartStream(response, onFrame);
    response.parseMultipart = async () => {
      var totalBytes = 0;
      var resParts = [];
      if (typeof response.arrayBuffer === 'function') {
        try {
          var buf = await response.arrayBuffer();
          totalBytes = buf ? buf.byteLength : 0;
          resParts = window.xintent.parseMultipartArrayBuffer(buf);
        } catch (_) {}
      }
      if (!resParts || resParts.length === 0) {
        var text = await response.text();
        totalBytes = text ? text.length : 0;
        resParts = window.xintent.parseMultipartResponse(text);
      }
      logNative('[XIntent HTTP 📦] Parsed ' + (intentName || 'intent') + ' response body: ' + totalBytes + ' bytes (' + resParts.length + ' parts)');
      return resParts;
    };
    return response;
  }

  function splitBytesByBoundary(bytes, boundaryBytes) {
    var rawPartBuffers = [];
    var start = 0;
    while (start < bytes.length) {
      var pos = -1;
      for (var i = start; i <= bytes.length - boundaryBytes.length; i++) {
        var match = true;
        for (var j = 0; j < boundaryBytes.length; j++) {
          if (bytes[i + j] !== boundaryBytes[j]) { match = false; break; }
        }
        if (match) { pos = i; break; }
      }
      if (pos === -1) {
        rawPartBuffers.push(bytes.subarray(start));
        break;
      }
      if (pos > start) rawPartBuffers.push(bytes.subarray(start, pos));
      start = pos + boundaryBytes.length;
    }
    return rawPartBuffers;
  }

  function findBinaryHeaderSeparator(pBytes) {
    for (var m = 0; m <= pBytes.length - 4; m++) {
      if (pBytes[m] === 13 && pBytes[m + 1] === 10 && pBytes[m + 2] === 13 && pBytes[m + 3] === 10) {
        return { pos: m, len: 4 };
      }
    }
    for (var m2 = 0; m2 <= pBytes.length - 2; m2++) {
      if (pBytes[m2] === 10 && pBytes[m2 + 1] === 10) {
        return { pos: m2, len: 2 };
      }
    }
    return null;
  }

  function parseBinaryMultipartPart(pBytes, textDecoder) {
    var sep = pBytes && pBytes.length > 0 ? findBinaryHeaderSeparator(pBytes) : null;
    if (!sep) return null;

    var headers = parseHeaderLines(textDecoder.decode(pBytes.subarray(0, sep.pos)));
    var bodyBytes = pBytes.subarray(sep.pos + sep.len);
    var contentType = headers['content-type'] || '';

    if (contentType.includes('application/json') || contentType.includes('+json')) {
      try {
        return { headers: headers, json: JSON.parse(textDecoder.decode(bodyBytes)), body: bodyBytes.buffer };
      } catch (_) {}
    }
    return { headers: headers, body: bodyBytes.buffer };
  }

  function parseTextMultipartPart(part) {
    var trimmed = (part || '').trim();
    if (!trimmed || trimmed.startsWith('--')) return null;
    var crlfPos = part.indexOf('\r\n\r\n');
    var headerEnd = crlfPos !== -1 ? crlfPos : part.indexOf('\n\n');
    if (headerEnd === -1) return null;

    var headers = parseHeaderLines(part.slice(0, headerEnd));
    var bodyText = part.slice(headerEnd).trim();
    try {
      return { headers: headers, json: JSON.parse(bodyText), body: bodyText };
    } catch (_) {
      return { headers: headers, json: null, body: bodyText };
    }
  }

  function extractBoundaryFromBuffer(buffer) {
    if (!buffer.includes('MatchboxFrameBoundary')) return null;
    var lines = buffer.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].includes('MatchboxFrameBoundary')) {
        return lines[i].trim().replace(/^--/, '').replace(/--$/, '');
      }
    }
    return null;
  }

  function flushStreamParts(buffer, boundary, onFrame) {
    var parts = buffer.split('--' + boundary);
    var remainingBuffer = parts.pop() || '';
    for (var j = 0; j < parts.length; j++) {
      var parsed = parseTextMultipartPart(parts[j]);
      if (parsed && typeof onFrame === 'function') onFrame(parsed);
    }
    var remParsed = parseTextMultipartPart(remainingBuffer);
    if (remParsed && remParsed.json) {
      if (typeof onFrame === 'function') onFrame(remParsed);
      return '';
    }
    return remainingBuffer;
  }

  function formatErrorDetails(err) {
    if (!err) return String(err);
    var keys = ['message', 'name', 'code', 'type', 'stack'];
    var details = keys.filter((k) => Boolean(err[k])).map((k) => k + '=' + err[k]);
    return details.length > 0 ? details.join(', ') : String(err);
  }

  function parseWsEventFrame(rawData) {
    if (typeof rawData === 'string' && (rawData.indexOf('Content-Type:') !== -1 || rawData.indexOf('MatchboxFrameBoundary') !== -1)) {
      var parts = window.xintent ? window.xintent.parseMultipartResponse(rawData) : [];
      if (parts.length === 0) return null;
      var frame = parts[0].json || parts[0].body;
      if (parts.length > 1 && parts[1].body) {
        frame = Object.assign({}, typeof frame === 'object' ? frame : { data: frame }, { blob: parts[1].body });
      }
      return frame;
    }
    return JSON.parse(rawData);
  }

  window.xintent = window.xintent || {
    SYN: 1,
    FIN: 2,
    SYN_FIN: 3,

    getAudioMode: () => getRoutingMode('getAudioRoutingMode', 'isLocalAudioEnabled', 'doLocalAudioCapture'),
    getTtsMode: () => getRoutingMode('getTtsRoutingMode', 'isLocalTtsEnabled', 'doLocalTtsCapture'),
    getClipboardMode: () => getRoutingMode('getClipboardRoutingMode', 'isLocalClipboardEnabled', 'doLocalClipboardCapture'),
    getFsMode: () => getRoutingMode('getFsRoutingMode', 'isLocalFsEnabled', 'doLocalFsCapture'),
    getDefaultRemoteDevice: () => callNative('getDefaultRemoteDevice') || 'user-desktop',

    getTags: async () => {
      try {
        var raw = callNative('fetchApiTagsJson');
        if (raw) return JSON.parse(raw);
      } catch (_) {}
      var res = await fetch('/api/tags');
      return await res.json();
    },

    intent: async (intentName, payload, targetApp) => {
      var routed = resolveIntentRouting(intentName, payload, targetApp);
      if (routed.handled) return routed.response;

      var req = buildIntentRequest(intentName, payload, routed.targetApp);
      logNative('[XIntent HTTP ➡️] Sending ' + intentName + ' to ' + req.url + ' (targetApp: ' + req.app + ')');

      var response = await fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.bodyData)
      });

      var cLen = response.headers ? response.headers.get('content-length') : null;
      var lenSuffix = cLen ? ' (Content-Length: ' + cLen + ' bytes)' : ' (chunked/streaming)';
      logNative('[XIntent HTTP ⬅️] Received HTTP ' + response.status + ' response for ' + intentName + lenSuffix);

      return attachResponseHelpers(response, intentName);
    },

    parseMultipartArrayBuffer: (arrayBuffer) => {
      var parts = [];
      if (!arrayBuffer) return parts;
      var bytes = new Uint8Array(arrayBuffer);
      var textDecoder = new TextDecoder('utf-8');
      var headerSnippet = textDecoder.decode(bytes.subarray(0, Math.min(bytes.length, 2048)));

      if (!headerSnippet.includes('MatchboxFrameBoundary')) {
        try {
          parts.push({ headers: {}, json: JSON.parse(textDecoder.decode(bytes)) });
        } catch (_) {
          parts.push({ headers: {}, body: arrayBuffer });
        }
        return parts;
      }

      var firstLineEnd = headerSnippet.indexOf('\n');
      var boundaryStr = (firstLineEnd !== -1 ? headerSnippet.substring(0, firstLineEnd) : headerSnippet).trim();
      var rawPartBuffers = splitBytesByBoundary(bytes, new TextEncoder().encode(boundaryStr));

      for (var k = 0; k < rawPartBuffers.length; k++) {
        var parsedPart = parseBinaryMultipartPart(rawPartBuffers[k], textDecoder);
        if (parsedPart) parts.push(parsedPart);
      }
      return parts;
    },

    parseMultipartResponse: (responseText) => {
      var parts = [];
      if (!responseText || typeof responseText !== 'string') return parts;

      if (!responseText.includes('MatchboxFrameBoundary')) {
        try {
          parts.push({ headers: {}, json: JSON.parse(responseText) });
        } catch (_) {
          parts.push({ headers: {}, body: responseText });
        }
        return parts;
      }

      var boundary = responseText.split(/\r?\n/)[0].trim();
      var rawParts = responseText.split(boundary);
      for (var i = 0; i < rawParts.length; i++) {
        var raw = rawParts[i];
        if (!raw.trim() || raw.includes('--\r') || raw.includes('--\n')) continue;
        var parsed = parseTextMultipartPart(raw);
        if (parsed) {
          var item = { headers: parsed.headers, body: parsed.body };
          if (parsed.json !== null) item.json = parsed.json;
          parts.push(item);
        }
      }
      return parts;
    },

    readMultipartStream: async (response, onFrame) => {
      if (!response || !response.body) return;
      var reader = response.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var state = { buffer: '', boundary: null, bytes: 0, chunks: 0 };

      response.getBytesReceived = () => state.bytes;
      response.getChunkCount = () => state.chunks;
      window.xintent.lastStreamMetrics = {
        getBytesReceived: response.getBytesReceived,
        getChunkCount: response.getChunkCount
      };

      while (true) {
        var res = await reader.read();
        if (res.value) {
          state.bytes += res.value.byteLength;
          state.chunks++;
          state.buffer += decoder.decode(res.value, { stream: true });
        }
        if (!state.boundary) state.boundary = extractBoundaryFromBuffer(state.buffer);
        if (state.boundary) state.buffer = flushStreamParts(state.buffer, state.boundary, onFrame);
        if (res.done) {
          if (state.buffer.trim() && typeof onFrame === 'function') {
            window.xintent.parseMultipartResponse(state.buffer).forEach((part) => {
              try { onFrame(part); } catch (_) {}
            });
          }
          break;
        }
      }
    }
  };

  function resolveXAudioTargetApp(explicitApp) {
    if (explicitApp) return explicitApp;
    var audioMode = window.xintent ? window.xintent.getAudioMode() : 'normal';
    return audioMode === 'doRemoteAudioCapture' ? window.xintent.getDefaultRemoteDevice() : 'localhost';
  }

  function createXAudioWebSocket(owner, wsUrl) {
    try {
      var ws = new WebSocket(wsUrl, 'message-http');
      owner._ws = ws;
      ws.onopen = () => console.log('[xaudio] Real-time message/http WebSocket connected to ' + wsUrl);
      ws.onerror = (errEv) => console.warn('[xaudio] WebSocket error on ' + wsUrl + ': ' + formatErrorDetails(errEv), errEv);
      ws.onmessage = (event) => {
        try {
          var frame = parseWsEventFrame(event.data);
          if (frame && owner._wsListeners) {
            owner._wsListeners.forEach((fn) => { try { fn(frame); } catch (_) {} });
          }
        } catch (_) {}
      };
      ws.onclose = () => { owner._ws = null; };
      return ws;
    } catch (err) {
      console.warn('[xaudio] Could not establish WebSocket to ' + wsUrl + ': ' + formatErrorDetails(err), err);
      return null;
    }
  }

  window.xaudio = window.xaudio || {
    connectXAudioWs: function(onFrameHandler, sinkName) {
      this._wsListeners = this._wsListeners || [];
      if (typeof onFrameHandler === 'function') this._wsListeners.push(onFrameHandler);
      if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) return this._ws;

      var wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      var host = window.location.host || 'localhost:12345';
      var sink = (sinkName && sinkName !== 'default') ? sinkName : 'user-desktop-speakers';
      return createXAudioWebSocket(this, wsProtocol + '//' + host + '/xaudio?XAudioSink=' + encodeURIComponent(sink));
    },

    XAudioPlay: async function(cookieOrOptions, seqnum, sample) {
      var options = (typeof cookieOrOptions === 'object' && cookieOrOptions !== null) ? cookieOrOptions : {
        cookie: cookieOrOptions,
        seqnum: seqnum || 0,
        sample: sample || seqnum || 0
      };
      var cookie = options.cookie || options.Cookie || options.OutputId || 'default';
      var seq = options.seqnum !== undefined ? options.seqnum : (options.seq || 0);
      var blobId = options.sample || options.blob || options.blobId || options.BlobId;
      var audioMode = window.xintent ? window.xintent.getAudioMode() : 'normal';
      var app = resolveXAudioTargetApp(audioMode === 'doRemoteAudioCapture' ? null : options.app);

      var payload = Object.assign({
        intent: 'xaudio.PlaySoundBlob',
        app: app,
        OutputId: cookie,
        cookie: cookie,
        streamId: options.streamId || 1,
        seqnum: seq,
        sample: blobId,
        controlWord: options.controlWord || 1
      }, options, { app: app });

      if (audioMode === 'doLocalAudioCapture') {
        logNative('[xaudio.XAudioPlay 🔊] Local XAudioPlay for ' + cookie + ' seq #' + seq + ' (sample/blob: ' + blobId + ')');
        return jsonResponse(callNative('handleLocalAudioPlay', JSON.stringify(payload)));
      }

      var ws = this.connectXAudioWs(null, app);
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
        var msg = JSON.stringify(payload);
        if (ws.readyState === 1) ws.send(msg);
        else ws.addEventListener('open', () => { try { ws.send(msg); } catch (_) {} }, { once: true });
        return jsonResponse(JSON.stringify({ status: 200, queued: true, seqnum: seq, via: 'websocket' }));
      }

      return window.xintent.intent('xaudio.PlaySoundBlob', payload, app);
    },

    prefetchSoundBlob: async (options) => {
      options = options || {};
      var audioMode = window.xintent ? window.xintent.getAudioMode() : 'normal';
      var app = resolveXAudioTargetApp(options.app);
      var payload = Object.assign({ intent: 'xaudio.PrefetchSoundBlob', app: app }, options, { app: app });

      if (audioMode === 'doLocalAudioCapture') {
        return jsonResponse(callNative('handleLocalPrefetch', JSON.stringify(payload)));
      }
      return window.xintent.intent('xaudio.PrefetchSoundBlob', payload, app);
    },

    controlStream: async (options) => {
      var isObj = typeof options === 'object' && options !== null;
      var command = typeof options === 'string' ? options : ((isObj && options.command) || 'stop');
      var app = resolveXAudioTargetApp(isObj ? options.app : null);
      var payload = Object.assign({ intent: 'xaudio.ControlStream', command: command, app: app }, isObj ? options : {}, { app: app });
      return window.xintent.intent('xaudio.ControlStream', payload, app);
    },

    seekStream: async (options) => {
      options = options || {};
      var app = resolveXAudioTargetApp(options.app);
      var payload = Object.assign({ intent: 'xaudio.SeekStream', app: app }, options, { app: app });
      return window.xintent.intent('xaudio.SeekStream', payload, app);
    }
  };

  window.xhtml = window.xhtml || {
    cardWin: null,
    cardApp: 'xhtml-card',
    cardId: 'main',
    heldBlobs: new Set(),
    softLinkedBlobs: new Set(),
    openChannels: new Map(),
    onfreeze: null,
    onthaw: null,

    ensureCardSession: async function() {
      if (this.cardWin) return this.cardWin;
      try {
        var parts = (window.location.pathname || '').split('/').filter(Boolean);
        if (parts[0] === 'apps' && parts[1]) {
          this.cardApp = parts[1];
          this.cardId = parts[2] || 'main';
        }
        var res = await fetch('/api/card-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-By': 'flammenwerfer-web-card' },
          body: JSON.stringify({ appId: this.cardApp, cardId: this.cardId })
        });
        if (res.ok) {
          var data = await res.json();
          if (data.cardWin) this.cardWin = data.cardWin;
        }
      } catch (_) {}
      return this.cardWin;
    },

    serializeState: async function() {
      await this.ensureCardSession();
      var customState = null;
      if (typeof this.onfreeze === 'function') {
        try { customState = await this.onfreeze(); } catch (_) {}
      }
      var ls = {};
      var ss = {};
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k !== null) ls[k] = localStorage.getItem(k);
        }
        for (var j = 0; j < sessionStorage.length; j++) {
          var sk = sessionStorage.key(j);
          if (sk !== null) ss[sk] = sessionStorage.getItem(sk);
        }
      } catch (_) {}
      var inputs = {};
      try {
        var els = document.querySelectorAll('input, select, textarea');
        for (var m = 0; m < els.length; m++) {
          var el = els[m];
          var key = el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : 'input:' + m);
          if (el.type === 'checkbox' || el.type === 'radio') {
            inputs[key] = { checked: Boolean(el.checked), value: el.value };
          } else if (el.type !== 'file') {
            inputs[key] = el.value;
          }
        }
      } catch (_) {}
      return {
        version: '0.1',
        cardApp: this.cardApp,
        cardId: this.cardId,
        cardWin: this.cardWin,
        url: window.location ? window.location.href : '',
        timestamp: Date.now(),
        storage: { localStorage: ls, sessionStorage: ss },
        domState: { scroll: { x: window.scrollX || 0, y: window.scrollY || 0 }, inputs: inputs },
        heldBlobs: Array.from(this.heldBlobs),
        softLinkedBlobs: Array.from(this.softLinkedBlobs),
        openChannels: Array.from(this.openChannels.values()).map((ch) => ({
          txId: ch.txId,
          intent: ch.intent || null,
          app: ch.app || null
        })),
        customState: customState
      };
    },

    liveMigrate: async function(targetApp, options) {
      var resolvedTarget = targetApp || (window.xintent.getDefaultRemoteDevice() + ':cool-xhtml-runtime');
      var snapshot = await this.serializeState();
      var createHeaders = {
        'Content-Type': 'application/json',
        'X-Forwarded-By': 'flammenwerfer-web-card'
      };
      if (this.cardWin) createHeaders['X-Card-Window'] = String(this.cardWin);
      var blobRes = await fetch('/blobs', {
        method: 'PUT',
        headers: createHeaders,
        body: JSON.stringify({
          xblobType: 'Blob',
          type: 'application/json',
          name: this.cardApp + '-' + this.cardId + '.xhtml-snapshot.json',
          data: snapshot
        })
      });
      var blobJson = await blobRes.json();
      var stateBlobId = blobJson.blobId || blobJson.blob;
      if (this.heldBlobs) this.heldBlobs.delete(String(stateBlobId));

      logNative('[xhtml.LiveMigrate 🚀] Migrating card ' + this.cardApp + '/' + this.cardId + ' (cardWin=' + this.cardWin + ', stateBlob=' + stateBlobId + ') to ' + resolvedTarget);
      var res = await window.xintent.intent('xhtml.LiveMigrate', Object.assign({
        intent: 'xhtml.LiveMigrate',
        app: resolvedTarget,
        cardApp: this.cardApp,
        cardId: this.cardId,
        oldCardWin: this.cardWin,
        dataBlob: stateBlobId,
        controlWord: 1
      }, options || {}), resolvedTarget);

      var parts = typeof res.parseMultipart === 'function' ? await res.parseMultipart() : [];
      var result = (parts[0] && parts[0].json) || { status: res.ok ? 'ok' : 'error' };
      callNative('onCardMigrated');
      return result;
    }
  };

  console.log('[Flammenwerfer] Attached window.xintent, window.xaudio, and window.xhtml runtime library.');
})();
