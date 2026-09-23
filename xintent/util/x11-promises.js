// x11-promises.js
const x11 = require('x11');

// X11 client methods that dispatch asynchronous requests with callbacks
const REPLY_METHODS = new Set([
  'InternAtom',
  'GetAtomName',
  'GetProperty',
  'GetGeometry',
  'QueryTree',
  'GetWindowAttributes',
  'PointerMapping',
  'KeyboardMapping',
  'GetModifierMapping',
  'GetMotionEvents',
  'TranslateCoordinates',
  'GetInputFocus',
  'QueryFont',
  'QueryTextExtents',
  'ListProperties',
  'GetSelectionOwner',
  'GrabPointer',
  'GrabKeyboard'
]);

function wrapPromiseXClient(client) {
  const pendingRequests = new Map(); // seq -> { resolve, reject }

  // Route X11 protocol error frames to sequence-matched Promises
  client.on('error', (err) => {
    const seq = err.seq;

    // Check exact sequence or 16-bit sequence roll-over match
    const pendingKey = [seq, seq % 65536].find(s => pendingRequests.has(s));

    if (pendingKey !== undefined) {
      const { reject } = pendingRequests.get(pendingKey);
      pendingRequests.delete(pendingKey);

      // Remove stranded callback from node-x11 internal replies map if present
      if (client.replies) {
        delete client.replies[seq];
        delete client.replies[seq % 65536];
      }

      reject(err);
    } else {
      // Fire-and-forget request error or unhandled window event
      console.warn('[X11 Protocol Warning]:', err.message, {
        error: err.error,
        seq: err.seq,
        majorOpcode: err.majorOpcode,
        minorOpcode: err.minorOpcode,
        badParam: err.badParam
      });
    }
  });

  return new Proxy(client, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig === 'function' && REPLY_METHODS.has(prop)) {
        return (...args) => new Promise((resolve, reject) => {
          let reqSeq;

          // Execute request synchronous dispatch
          orig.call(target, ...args, (err, ...results) => {
            if (reqSeq !== undefined) {
              pendingRequests.delete(reqSeq);
            }
            if (err) return reject(err);
            resolve(results.length > 1 ? results : results[0]);
          });

          // Capture the sequence number assigned by node-x11 during dispatch
          reqSeq = target.seq_num;
          if (reqSeq !== undefined) {
            pendingRequests.set(reqSeq, { resolve, reject });
          }
        });
      }
      return typeof orig === 'function' ? orig.bind(target) : orig;
    }
  });
}

x11.createClientWithPromises = (options = {}) => {
  return new Promise((resolve, reject) => {
    x11.createClient(options, (err, display) => {
      if (err) return reject(err);      
      const X = wrapPromiseXClient(display.client);
      resolve({
        X,
        rawX: display.client,
        display,
        root: display.screen[0].root
      });
    });
  });
};

x11.internAtomExclusive = async (X, atomName) => {
  const req1 = X.InternAtom(true,  atomName); // returns 0 (None) if missing
  const req2 = X.InternAtom(false, atomName); // creates atom if missing

  const [existingAtom, finalAtom] = await Promise.all([req1, req2]);

  return {
    created: existingAtom === 0,
    atom: finalAtom
  };
};

x11.internAtomExclusiveRetry = async (X, atomName, maxAttempts = 100) => {
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const candidateName = attempt == 0 ? atomName : `${atomName}_${attempt}`;
    const { created, atom } = await x11.internAtomExclusive(X, candidateName);
    if (created) {
      return { created, atom, name: candidateName };
    }
  }
  throw new Error(`internAtomExclusiveRetry: couldn't claim a unique atom for "${atomName}" after ${maxAttempts} attempts`);
};


module.exports = x11;