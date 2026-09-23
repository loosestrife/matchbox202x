// x11-promises.js
const x11 = require('x11');

const REPLY_METHODS = new Set([
  'InternAtom', 'GetAtomName', 'GetProperty', 'GetGeometry',
  'QueryTree', 'GetWindowAttributes', 'PointerMapping', 'KeyboardMapping',
  'GetModifierMapping', 'GetMotionEvents', 'TranslateCoordinates',
  'GetInputFocus', 'QueryFont', 'QueryTextExtents', 'ListProperties',
  'GetSelectionOwner', 'GrabPointer', 'GrabKeyboard', 'QueryBestSize',
  'QueryExtension', 'ListExtensions'
]);

// Synchronous local client methods that should NOT return Promises
const SYNC_METHODS = new Set([
  'AllocID', 'on', 'once', 'addListener', 'removeListener',
  'removeAllListeners', 'emit', 'listeners', 'eventNames', 'off',
  'end', 'destroy', 'close'
]);

// Helper for 16-bit sequence number comparison (handles 65535 -> 0 rollover)
function seqDiff16(a, b) {
  return ((a - b) & 0xffff) << 16 >> 16;
}

function wrapPromiseXClient(client) {
  const pendingRequests = new Map(); // seq -> PendingEntry

  // Advances the internal sequence clock and resolves/rejects pending promises
  function processIncomingPacket(pktType, pkt, pktSeq) {
    if (pktSeq === undefined && pkt && pkt.seq !== undefined) {
      pktSeq = pkt.seq;
    }
    if (pktSeq === undefined) return;

    const pktSeq16 = pktSeq % 65536;

    // 1. Handle Protocol Error
    if (pktType === 'error') {
      for (const [seqKey, entry] of pendingRequests.entries()) {
        if (entry.seq16 === pktSeq16) {
          entry.reject(pkt);
          pendingRequests.delete(seqKey);
          if (client.replies) delete client.replies[seqKey];
          break;
        }
      }
      return;
    }

    // 2. Process non-error packet arrival across all pending requests
    for (const [seqKey, entry] of pendingRequests.entries()) {
      // A) Check explicit packet predicate match (seekResponsePacket)
      if (entry.seekPredicate) {
        try {
          if (entry.seekPredicate(pkt)) {
            if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
            entry.resolve(pkt);
            pendingRequests.delete(seqKey);
            if (client.replies) delete client.replies[seqKey];
            continue;
          }
        } catch (predicateErr) {
          if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
          entry.reject(predicateErr);
          pendingRequests.delete(seqKey);
          if (client.replies) delete client.replies[seqKey];
          continue;
        }
      }

      // B) Passive Auto-Resolution for Void / Past Requests
      if (!entry.seekPredicate && !entry.isReplyMethod) {
        if (seqDiff16(entry.seq16, pktSeq16) <= 0) {
          entry.resolve();
          pendingRequests.delete(seqKey);
        }
      }
    }
  }

  // Hook wire events to advance sequence clock
  client.on('event', (ev) => processIncomingPacket('event', ev, ev.seq));
  client.on('error', (err) => processIncomingPacket('error', err, err.seq));

  // Helper to create and register sequence-tracked Promises
  function dispatchRequest(prop, args, preconfiguredSeek = null) {
    const isReply = REPLY_METHODS.has(prop);
    let reqSeq;
    let resolvePromise, rejectPromise;

    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const orig = client[prop];

    if (isReply) {
      orig.call(client, ...args, (err, ...results) => {
        if (reqSeq !== undefined) {
          processIncomingPacket('reply', results[0], reqSeq);
          pendingRequests.delete(reqSeq);
        }
        if (err) return rejectPromise(err);
        resolvePromise(results.length > 1 ? results : results[0]);
      });
    } else {
      orig.call(client, ...args);
    }

    reqSeq = client.seq_num;
    promise.seq = reqSeq;

    const pendingEntry = {
      seq: reqSeq,
      seq16: reqSeq !== undefined ? reqSeq % 65536 : 0,
      isReplyMethod: isReply,
      resolve: resolvePromise,
      reject: rejectPromise,
      seekPredicate: preconfiguredSeek ? preconfiguredSeek.predicate : null,
      timeoutTimer: null
    };

    if (reqSeq !== undefined) {
      pendingRequests.set(reqSeq, pendingEntry);
    }

    // Attach .seekResponsePacket(...) builder method to returned Promise
    promise.seekResponsePacket = function(predicate, timeoutMs = 5000) {
      pendingEntry.seekPredicate = predicate;

      if (timeoutMs > 0) {
        pendingEntry.timeoutTimer = setTimeout(() => {
          if (pendingRequests.has(reqSeq)) {
            pendingRequests.delete(reqSeq);
            rejectPromise(new Error(`seekResponsePacket: timed out after ${timeoutMs}ms (seq ${reqSeq})`));
          }
        }, timeoutMs);
      }
      return promise;
    };

    if (preconfiguredSeek && preconfiguredSeek.timeoutMs > 0) {
      promise.seekResponsePacket(preconfiguredSeek.predicate, preconfiguredSeek.timeoutMs);
    }

    return promise;
  }

  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'seekResponsePacket') {
        return (predicate, timeoutMs = 5000) => {
          return new Proxy(target, {
            get(subTarget, subProp) {
              const subOrig = subTarget[subProp];
              if (typeof subOrig === 'function') {
                if (SYNC_METHODS.has(subProp)) {
                  return subOrig.bind(subTarget);
                }
                return (...args) => dispatchRequest(subProp, args, { predicate, timeoutMs });
              }
              return subOrig;
            }
          });
        };
      }

      const orig = target[prop];
      if (typeof orig === 'function') {
        if (SYNC_METHODS.has(prop)) {
          return orig.bind(target);
        }
        return (...args) => dispatchRequest(prop, args);
      }
      return orig;
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
  const req1 = X.InternAtom(true,  atomName);
  const req2 = X.InternAtom(false, atomName);
  const [existingAtom, finalAtom] = await Promise.all([req1, req2]);
  return { created: existingAtom === 0, atom: finalAtom };
};

x11.internAtomExclusiveRetry = async (X, atomName, maxAttempts = 100) => {
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const candidateName = attempt == 0 ? atomName : `${atomName}_${attempt}`;
    const { created, atom } = await x11.internAtomExclusive(X, candidateName);
    if (created) return { created, atom, name: candidateName };
  }
  throw new Error(`internAtomExclusiveRetry: couldn't claim a unique atom for "${atomName}" after ${maxAttempts} attempts`);
};

module.exports = x11;