(function(window) {
  'use strict';

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
    intent: async function(intent, payload = {}, app = 'localhost') {
      const parts = intent.split('.');
      if (parts.length < 2) {
        throw new Error("Invalid intent format. Must be 'namespace.action' (e.g. 'ui.TextToSpeech')");
      }
      const [namespace, action] = parts;
      const endpoint = `/intent/${namespace}/${action}?app=${encodeURIComponent(app)}`;

      const headers = { 'Content-Type': 'application/json' };
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

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload)
        });
        return response;
      } catch (err) {
        console.warn('[xintent] Intent dispatch warning:', err);
        throw err;
      }
    },

    /**
     * Retrieve intent and app registration tags from the bridge API
     * @returns {Promise<{intents: Record<string, string[]>, apps: Record<string, any>}>}
     */
    getTags: async function() {
      const res = await fetch('/api/tags');
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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

      return window.xintent.intent('xaudio.PlaySoundBlob', {
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
      }, app);
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
