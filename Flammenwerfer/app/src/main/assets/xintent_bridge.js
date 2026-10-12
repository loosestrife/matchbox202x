(function() {
  if (window.xintent && typeof window.xintent.intent === 'function' && window.xaudio) return;

  window.xintent = window.xintent || {
    SYN: 1,
    FIN: 2,
    SYN_FIN: 3,

    getAudioMode: function() {
      if (window.XIntentNative && typeof window.XIntentNative.getAudioRoutingMode === 'function') {
        return window.XIntentNative.getAudioRoutingMode();
      }
      if (window.XIntentNative && typeof window.XIntentNative.isLocalAudioEnabled === 'function' && window.XIntentNative.isLocalAudioEnabled()) {
        return 'doLocalAudioCapture';
      }
      return 'normal';
    },

    getTtsMode: function() {
      if (window.XIntentNative && typeof window.XIntentNative.getTtsRoutingMode === 'function') {
        return window.XIntentNative.getTtsRoutingMode();
      }
      if (window.XIntentNative && typeof window.XIntentNative.isLocalTtsEnabled === 'function' && window.XIntentNative.isLocalTtsEnabled()) {
        return 'doLocalTtsCapture';
      }
      return 'normal';
    },

    getClipboardMode: function() {
      if (window.XIntentNative && typeof window.XIntentNative.getClipboardRoutingMode === 'function') {
        return window.XIntentNative.getClipboardRoutingMode();
      }
      if (window.XIntentNative && typeof window.XIntentNative.isLocalClipboardEnabled === 'function' && window.XIntentNative.isLocalClipboardEnabled()) {
        return 'doLocalClipboardCapture';
      }
      return 'normal';
    },

    getFsMode: function() {
      if (window.XIntentNative && typeof window.XIntentNative.getFsRoutingMode === 'function') {
        return window.XIntentNative.getFsRoutingMode();
      }
      if (window.XIntentNative && typeof window.XIntentNative.isLocalFsEnabled === 'function' && window.XIntentNative.isLocalFsEnabled()) {
        return 'doLocalFsCapture';
      }
      return 'normal';
    },

    getDefaultRemoteDevice: function() {
      if (window.XIntentNative && typeof window.XIntentNative.getDefaultRemoteDevice === 'function') {
        return window.XIntentNative.getDefaultRemoteDevice() || 'user-desktop';
      }
      return 'user-desktop';
    },

    getTags: async function() {
      if (window.XIntentNative && typeof window.XIntentNative.fetchApiTagsJson === 'function') {
        try {
          var raw = window.XIntentNative.fetchApiTagsJson();
          if (raw) return JSON.parse(raw);
        } catch(e) {}
      }
      var res = await fetch('/api/tags');
      return await res.json();
    },

    intent: async function(intentName, payload, targetApp) {
      var audioMode = window.xintent.getAudioMode();
      var ttsMode = window.xintent.getTtsMode();
      var clipboardMode = window.xintent.getClipboardMode();
      var fsMode = window.xintent.getFsMode();
      var defaultRemote = window.xintent.getDefaultRemoteDevice();

      if (intentName === 'xaudio.PlaySoundBlob' || intentName === 'xaudio.PlayStream') {
        if (audioMode === 'doLocalAudioCapture') {
          var logMsg = '[XIntent Local 🔊] Handling ' + intentName + ' locally on phone speaker';
          console.log(logMsg);
          if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') window.XIntentNative.logMessage(logMsg);
          var rawRes = window.XIntentNative.handleLocalAudioPlay(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else if (audioMode === 'doRemoteAudioCapture') {
          targetApp = defaultRemote;
        }
      }

      if (intentName === 'xaudio.ControlStream') {
        if (audioMode === 'doLocalAudioCapture') {
          var logMsg = '[XIntent Local 🛑] Handling xaudio.ControlStream locally on phone speaker';
          console.log(logMsg);
          if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') window.XIntentNative.logMessage(logMsg);
          var rawRes = window.XIntentNative.handleLocalAudioControl(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else if (audioMode === 'doRemoteAudioCapture') {
          targetApp = defaultRemote;
        }
      }

      if (intentName === 'ui.TextToSpeech') {
        if (ttsMode === 'doLocalTtsCapture') {
          var logMsg = '[XIntent Local 🗣️] Handling ui.TextToSpeech locally on Android speech engine';
          console.log(logMsg);
          if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') window.XIntentNative.logMessage(logMsg);
          var rawRes = window.XIntentNative.handleLocalTts(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else if (ttsMode === 'doRemoteTtsCapture') {
          targetApp = defaultRemote;
        }
      }

      if (intentName === 'ui.Copy') {
        if (clipboardMode === 'doLocalClipboardCapture') {
          var logMsg = '[XIntent Local 📋] Handling ui.Copy locally on Android clipboard';
          console.log(logMsg);
          if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') window.XIntentNative.logMessage(logMsg);
          var rawRes = window.XIntentNative.handleLocalCopy(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else if (clipboardMode === 'doRemoteClipboardCapture') {
          targetApp = defaultRemote;
        }
      }

      if (intentName === 'ui.Paste') {
        if (clipboardMode === 'doLocalClipboardCapture') {
          var logMsg = '[XIntent Local 📋] Handling ui.Paste locally from Android clipboard';
          console.log(logMsg);
          if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') window.XIntentNative.logMessage(logMsg);
          var rawRes = window.XIntentNative.handleLocalPaste();
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else if (clipboardMode === 'doRemoteClipboardCapture') {
          targetApp = defaultRemote;
        }
      }

      if (intentName === 'fs.PickFile') {
        if (fsMode === 'doLocalFsCapture') {
          var logMsg = '[XIntent Local 📁] Handling fs.PickFile locally via Android document picker';
          console.log(logMsg);
          if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') window.XIntentNative.logMessage(logMsg);
          var rawRes = window.XIntentNative.handleLocalPickFile(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else if (fsMode === 'doRemoteFsCapture') {
          targetApp = defaultRemote;
        }
      }

      if (intentName === 'fs.SaveAs') {
        if (fsMode === 'doLocalFsCapture') {
          var logMsg = '[XIntent Local 📁] Handling fs.SaveAs locally via Android file saver';
          console.log(logMsg);
          if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') window.XIntentNative.logMessage(logMsg);
          var rawRes = window.XIntentNative.handleLocalSaveAs(JSON.stringify(payload || {}));
          return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
        } else if (fsMode === 'doRemoteFsCapture') {
          targetApp = defaultRemote;
        }
      }

      var parts = (intentName || '').split('.');
      var namespace = parts[0] || 'ui';
      var action = parts[1] || intentName;
      var app = targetApp || (payload && payload.app) || 'localhost';

      var url = '/intent/' + namespace + '/' + action + '?app=' + encodeURIComponent(app);

      var bodyData = Object.assign({}, payload || {}, {
        intent: intentName,
        app: app
      });

      var isXAudio = (intentName || '').indexOf('xaudio.') === 0 || (intentName || '').indexOf('XAudio') === 0;

      if (bodyData.controlWord === undefined && (bodyData.Accept || isXAudio)) {
        bodyData.controlWord = 1;
      }

      var headers = {
        'Content-Type': 'application/json',
        'Accept': (payload && payload.Accept) ? payload.Accept : '*/*',
        'X-Forwarded-By': 'flammenwerfer-web-card'
      };

      if (bodyData.controlWord !== undefined) {
        var ctrlStrings = [];
        if (bodyData.controlWord & 1) ctrlStrings.push('SYN');
        if (bodyData.controlWord & 2) ctrlStrings.push('FIN');
        if (ctrlStrings.length > 0) {
          headers['X-Channel-Control'] = ctrlStrings.join(',');
        }
      }

      var sendLogMsg = '[XIntent HTTP ➡️] Sending ' + intentName + ' to ' + url + ' (targetApp: ' + app + ')';
      console.log(sendLogMsg);
      if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') {
        window.XIntentNative.logMessage(sendLogMsg);
      }

      var response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(bodyData)
      });

      var cLen = response.headers ? response.headers.get('content-length') : null;
      var recvLogMsg = '[XIntent HTTP ⬅️] Received HTTP ' + response.status + ' response for ' + intentName + (cLen ? ' (Content-Length: ' + cLen + ' bytes)' : ' (chunked/streaming)');
      console.log(recvLogMsg);
      if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') {
        window.XIntentNative.logMessage(recvLogMsg);
      }

      response.readMultipartStream = async function(onFrame) {
        return window.xintent.readMultipartStream(this, onFrame);
      };

      response.parseMultipart = async function() {
        var totalBytes = 0;
        var resParts = [];
        if (typeof this.arrayBuffer === 'function') {
          try {
            var buf = await this.arrayBuffer();
            totalBytes = buf ? buf.byteLength : 0;
            resParts = window.xintent.parseMultipartArrayBuffer(buf);
          } catch (_) {}
        }
        if (!resParts || resParts.length === 0) {
          var text = await this.text();
          totalBytes = text ? text.length : 0;
          resParts = window.xintent.parseMultipartResponse(text);
        }
        var parseLogMsg = '[XIntent HTTP 📦] Parsed ' + (intentName || 'intent') + ' response body: ' + totalBytes + ' bytes (' + resParts.length + ' parts)';
        console.log(parseLogMsg);
        if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') {
          window.XIntentNative.logMessage(parseLogMsg);
        }
        return resParts;
      };
      return response;
    },

    parseMultipartArrayBuffer: function(arrayBuffer) {
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
      var boundaryBytes = new TextEncoder().encode(boundaryStr);

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
          if (start < bytes.length) rawPartBuffers.push(bytes.subarray(start));
          break;
        }
        if (pos > start) rawPartBuffers.push(bytes.subarray(start, pos));
        start = pos + boundaryBytes.length;
      }

      for (var k = 0; k < rawPartBuffers.length; k++) {
        var pBytes = rawPartBuffers[k];
        if (pBytes.length === 0) continue;

        var sepPos = -1;
        var sepLen = 4;
        for (var m = 0; m <= pBytes.length - 4; m++) {
          if (pBytes[m] === 13 && pBytes[m+1] === 10 && pBytes[m+2] === 13 && pBytes[m+3] === 10) {
            sepPos = m; sepLen = 4; break;
          }
        }
        if (sepPos === -1) {
          for (var m2 = 0; m2 <= pBytes.length - 2; m2++) {
            if (pBytes[m2] === 10 && pBytes[m2+1] === 10) {
              sepPos = m2; sepLen = 2; break;
            }
          }
        }
        if (sepPos === -1) continue;

        var headerText = textDecoder.decode(pBytes.subarray(0, sepPos));
        var bodyBytes = pBytes.subarray(sepPos + sepLen);

        var headers = {};
        headerText.split(/\r?\n/).forEach(function(line) {
          var colon = line.indexOf(':');
          if (colon !== -1) {
            headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          }
        });

        var contentType = headers['content-type'] || '';
        if (contentType.includes('application/json') || contentType.includes('+json')) {
          try {
            var jsonStr = textDecoder.decode(bodyBytes);
            var json = JSON.parse(jsonStr);
            parts.push({ headers: headers, json: json, body: bodyBytes.buffer });
            continue;
          } catch (_) {}
        }
        parts.push({ headers: headers, body: bodyBytes.buffer });
      }
      return parts;
    },

    parseMultipartResponse: function(responseText) {
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

      var lines = responseText.split(/\r?\n/);
      var boundary = lines[0].trim();
      var rawParts = responseText.split(boundary).filter(function(p) {
        return p.trim() && !p.includes('--\r') && !p.includes('--\n');
      });

      for (var i = 0; i < rawParts.length; i++) {
        var part = rawParts[i];
        var headerEnd = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
        if (headerEnd === -1) continue;

        var headerText = part.slice(0, headerEnd);
        var bodyText = part.slice(headerEnd).trim();

        var headers = {};
        headerText.split(/\r?\n/).forEach(function(line) {
          var colon = line.indexOf(':');
          if (colon !== -1) {
            var k = line.slice(0, colon).trim().toLowerCase();
            var v = line.slice(colon + 1).trim();
            headers[k] = v;
          }
        });

        try {
          var json = JSON.parse(bodyText);
          parts.push({ headers: headers, json: json, body: bodyText });
        } catch (_) {
          parts.push({ headers: headers, body: bodyText });
        }
      }
      return parts;
    },

    readMultipartStream: async function(response, onFrame) {
      if (!response || !response.body) return;
      var reader = response.body.getReader();
      var decoder = new TextDecoder('utf-8');
      var buffer = '';
      var boundary = null;
      var totalBytesReceived = 0;
      var chunkCount = 0;

      response.getBytesReceived = function() { return totalBytesReceived; };
      response.getChunkCount = function() { return chunkCount; };
      window.xintent.lastStreamMetrics = {
        getBytesReceived: function() { return totalBytesReceived; },
        getChunkCount: function() { return chunkCount; }
      };

      while (true) {
        var res = await reader.read();
        if (res.value) {
          totalBytesReceived += res.value.byteLength;
          chunkCount++;
          buffer += decoder.decode(res.value, { stream: true });
        }

        if (!boundary && buffer.includes('MatchboxFrameBoundary')) {
          var lines = buffer.split(/\r?\n/);
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.includes('MatchboxFrameBoundary')) {
              var b = line.trim();
              if (b.startsWith('--')) b = b.slice(2);
              if (b.endsWith('--')) b = b.slice(0, -2);
              boundary = b;
              break;
            }
          }
        }

        if (boundary) {
          var delimiter = '--' + boundary;
          var parts = buffer.split(delimiter);
          var remainingBuffer = parts.pop() || '';

          for (var j = 0; j < parts.length; j++) {
            var part = parts[j];
            var trimmed = part.trim();
            if (!trimmed || trimmed === '--' || trimmed.startsWith('--')) continue;

            var headerEnd = part.indexOf('\r\n\r\n') !== -1 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
            if (headerEnd === -1) continue;

            var headerText = part.slice(0, headerEnd);
            var bodyText = part.slice(headerEnd).trim();

            var headers = {};
            headerText.split(/\r?\n/).forEach(function(l) {
              var colon = l.indexOf(':');
              if (colon !== -1) {
                headers[l.slice(0, colon).trim().toLowerCase()] = l.slice(colon + 1).trim();
              }
            });

            var json = null;
            try { json = JSON.parse(bodyText); } catch (_) {}

            if (typeof onFrame === 'function') {
              onFrame({ headers: headers, json: json, body: bodyText });
            }
          }

          var remainingTrimmed = remainingBuffer.trim();
          if (remainingTrimmed && remainingTrimmed !== '--' && !remainingTrimmed.startsWith('--')) {
            var hEnd = remainingBuffer.indexOf('\r\n\r\n') !== -1 ? remainingBuffer.indexOf('\r\n\r\n') : remainingBuffer.indexOf('\n\n');
            if (hEnd !== -1) {
              var hText = remainingBuffer.slice(0, hEnd);
              var bText = remainingBuffer.slice(hEnd).trim();
              var rJson = null;
              try {
                rJson = JSON.parse(bText);
                if (rJson) {
                  var rHeaders = {};
                  hText.split(/\r?\n/).forEach(function(l) {
                    var colon = l.indexOf(':');
                    if (colon !== -1) {
                      rHeaders[l.slice(0, colon).trim().toLowerCase()] = l.slice(colon + 1).trim();
                    }
                  });
                  if (typeof onFrame === 'function') {
                    onFrame({ headers: rHeaders, json: rJson, body: bText });
                  }
                  remainingBuffer = '';
                }
              } catch (_) {}
            }
          }

          buffer = remainingBuffer;
        }

        if (res.done) {
          if (buffer.trim()) {
            var finalParts = window.xintent.parseMultipartResponse(buffer);
            for (var m = 0; m < finalParts.length; m++) {
              if (typeof onFrame === 'function') {
                try { onFrame(finalParts[m]); } catch(_) {}
              }
            }
          }
          break;
        }
      }
    }
  };

  window.xaudio = window.xaudio || {
    connectXAudioWs: function(onFrameHandler, sinkName) {
      this._wsListeners = this._wsListeners || [];
      if (typeof onFrameHandler === 'function') {
        this._wsListeners.push(onFrameHandler);
      }

      if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1)) {
        return this._ws;
      }

      var wsProtocol = (window.location.protocol === 'https:') ? 'wss:' : 'ws:';
      var host = window.location.host || 'localhost:12345';
      var sink = (sinkName && sinkName !== 'default') ? sinkName : 'user-desktop-speakers';
      var wsUrl = wsProtocol + '//' + host + '/xaudio?XAudioSink=' + encodeURIComponent(sink);

      try {
        var ws = new WebSocket(wsUrl, 'message-http');
        this._ws = ws;
        var self = this;

        ws.onopen = function() {
          console.log('[xaudio] Real-time message/http WebSocket connected to ' + wsUrl);
        };

        ws.onerror = function(errEv) {
          var details = [];
          if (errEv) {
            if (errEv.message) details.push('message=' + errEv.message);
            if (errEv.name) details.push('name=' + errEv.name);
            if (errEv.code) details.push('code=' + errEv.code);
            if (errEv.type) details.push('type=' + errEv.type);
          }
          var detailStr = details.length > 0 ? details.join(', ') : String(errEv);
          console.warn('[xaudio] WebSocket error on ' + wsUrl + ': ' + detailStr, errEv);
        };

        ws.onmessage = function(event) {
          try {
            var frame = null;
            if (typeof event.data === 'string' && (event.data.indexOf('Content-Type:') !== -1 || event.data.indexOf('MatchboxFrameBoundary') !== -1)) {
              var parts = window.xintent ? window.xintent.parseMultipartResponse(event.data) : [];
              if (parts.length > 0) {
                frame = parts[0].json || parts[0].body;
                if (parts.length > 1 && parts[1].body) {
                  frame = Object.assign({}, typeof frame === 'object' ? frame : { data: frame }, { blob: parts[1].body });
                }
              }
            } else {
              frame = JSON.parse(event.data);
            }
            if (frame) {
              for (var i = 0; i < self._wsListeners.length; i++) {
                try { self._wsListeners[i](frame); } catch (_) {}
              }
            }
          } catch (_) {}
        };

        ws.onclose = function() {
          self._ws = null;
        };

        return ws;
      } catch (err) {
        var errDetails = [];
        if (err) {
          if (err.message) errDetails.push('message=' + err.message);
          if (err.name) errDetails.push('name=' + err.name);
          if (err.code) errDetails.push('code=' + err.code);
          if (err.stack) errDetails.push('stack=' + err.stack);
        }
        var errStr = errDetails.length > 0 ? errDetails.join(', ') : String(err);
        console.warn('[xaudio] Could not establish WebSocket to ' + wsUrl + ': ' + errStr, err);
        return null;
      }
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
      var app = options.app || 'localhost';

      var audioMode = window.xintent ? window.xintent.getAudioMode() : 'normal';
      if (audioMode === 'doRemoteAudioCapture') {
        app = window.xintent.getDefaultRemoteDevice();
      }

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
        var logMsg = '[xaudio.XAudioPlay 🔊] Local XAudioPlay for ' + cookie + ' seq #' + seq + ' (sample/blob: ' + blobId + ')';
        console.log(logMsg);
        if (window.XIntentNative && typeof window.XIntentNative.logMessage === 'function') {
          window.XIntentNative.logMessage(logMsg);
        }
        var rawRes = window.XIntentNative.handleLocalAudioPlay(JSON.stringify(payload));
        return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      var ws = this.connectXAudioWs(null, app);
      if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
        if (ws.readyState === 1) {
          ws.send(JSON.stringify(payload));
        } else {
          ws.addEventListener('open', function() {
            try { ws.send(JSON.stringify(payload)); } catch(_) {}
          }, { once: true });
        }
        return new Response(JSON.stringify({ status: 200, queued: true, seqnum: seq, via: 'websocket' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return window.xintent.intent('xaudio.PlaySoundBlob', payload, app);
    },
    prefetchSoundBlob: async function(options) {
      options = options || {};
      var audioMode = window.xintent ? window.xintent.getAudioMode() : 'normal';
      var app = options.app || (audioMode === 'doRemoteAudioCapture' ? window.xintent.getDefaultRemoteDevice() : 'localhost');
      var payload = Object.assign({
        intent: 'xaudio.PrefetchSoundBlob',
        app: app
      }, options, { app: app });

      if (audioMode === 'doLocalAudioCapture') {
        var rawRes = window.XIntentNative.handleLocalPrefetch(JSON.stringify(payload));
        return new Response(rawRes, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return window.xintent.intent('xaudio.PrefetchSoundBlob', payload, app);
    },
    controlStream: async function(options) {
      options = options || {};
      var audioMode = window.xintent ? window.xintent.getAudioMode() : 'normal';
      var command = typeof options === 'string' ? options : (options.command || 'stop');
      var app = (typeof options === 'object' && options.app) ? options.app : (audioMode === 'doRemoteAudioCapture' ? window.xintent.getDefaultRemoteDevice() : 'localhost');
      return window.xintent.intent('xaudio.ControlStream', Object.assign({
        intent: 'xaudio.ControlStream',
        command: command,
        app: app
      }, typeof options === 'object' ? options : {}, { app: app }), app);
    },
    seekStream: async function(options) {
      options = options || {};
      var audioMode = window.xintent ? window.xintent.getAudioMode() : 'normal';
      var app = options.app || (audioMode === 'doRemoteAudioCapture' ? window.xintent.getDefaultRemoteDevice() : 'localhost');
      return window.xintent.intent('xaudio.SeekStream', Object.assign({
        intent: 'xaudio.SeekStream',
        app: app
      }, options, { app: app }), app);
    }
  };

  console.log('[Flammenwerfer] Attached window.xintent and window.xaudio runtime library.');
})();
