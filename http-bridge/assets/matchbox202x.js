(function(window) {
  'use strict';

  const BRIDGE_URL = 'http://localhost:12345';

  window.matchbox202x = {
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
      const endpoint = `${BRIDGE_URL}/intent/${namespace}/${action}?app=${encodeURIComponent(app)}`;

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        return response;
      } catch (err) {
        console.warn('[matchbox202x] Intent dispatch warning:', err);
        throw err;
      }
    }
  };
})(window);