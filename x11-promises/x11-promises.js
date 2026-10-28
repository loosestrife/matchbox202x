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

function clearPendingEntry(state, seqKey, entry) {
  if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
  state.pendingRequests.delete(seqKey);
  if (state.client.replies) delete state.client.replies[seqKey];
}

function resolvePacketSeq(pkt, pktSeq) {
  if (pktSeq !== undefined) return pktSeq;
  if (!pkt) return undefined;
  return pkt.seq !== undefined ? pkt.seq : pkt.sequence;
}

function handleErrorPacket(state, pkt, pktSeq) {
  if (pktSeq === undefined) return;
  const pktSeq16 = pktSeq % 65536;
  for (const [seqKey, entry] of state.pendingRequests.entries()) {
    if (entry.seq16 === pktSeq16) {
      entry.reject(pkt);
      clearPendingEntry(state, seqKey, entry);
      break;
    }
  }
}

function tryMatchSeekPredicate(state, seqKey, entry, pkt) {
  try {
    if (pkt && entry.seekPredicate(pkt)) {
      clearPendingEntry(state, seqKey, entry);
      entry.resolve(pkt);
      return true;
    }
  } catch (predicateErr) {
    clearPendingEntry(state, seqKey, entry);
    entry.reject(predicateErr);
    return true;
  }
  return false;
}

function tryAutoResolveVoidRequest(state, seqKey, entry, pktSeq) {
  if (entry.seekPredicate || entry.isReplyMethod || pktSeq === undefined) return;
  if (seqDiff16(entry.seq16, pktSeq % 65536) <= 0) {
    entry.resolve();
    state.pendingRequests.delete(seqKey);
  }
}

// Advances the internal sequence clock and resolves/rejects pending promises
function processIncomingPacket(state, pktType, pkt, pktSeq) {
  const resolvedSeq = resolvePacketSeq(pkt, pktSeq);
  if (pktType === 'error') {
    handleErrorPacket(state, pkt, resolvedSeq);
    return;
  }

  for (const [seqKey, entry] of state.pendingRequests.entries()) {
    if (entry.seekPredicate && tryMatchSeekPredicate(state, seqKey, entry, pkt)) {
      continue;
    }
    tryAutoResolveVoidRequest(state, seqKey, entry, resolvedSeq);
  }
}

function scheduleSeekTimeout(state, pendingEntry, timeoutMs) {
  if (timeoutMs <= 0) return;
  pendingEntry.timeoutTimer = setTimeout(() => {
    if (state.pendingRequests.has(pendingEntry.key)) {
      state.pendingRequests.delete(pendingEntry.key);
      pendingEntry.reject(new Error(`seekResponsePacket: timed out after ${timeoutMs}ms (seq ${pendingEntry.seq})`));
    }
  }, timeoutMs);
}

function attachSeekBuilder(state, promise, pendingEntry) {
  promise.seekResponsePacket = function(predicate, timeoutMs = 5000) {
    pendingEntry.seekPredicate = predicate;
    if (pendingEntry.seq !== undefined) {
      state.pendingRequests.set(pendingEntry.key, pendingEntry);
    }
    scheduleSeekTimeout(state, pendingEntry, timeoutMs);
    return promise;
  };
}

function handleReplyCallback(state, pendingEntry, err, results) {
  if (pendingEntry.seq !== undefined) {
    processIncomingPacket(state, 'reply', results[0], pendingEntry.seq);
    state.pendingRequests.delete(pendingEntry.key);
  }
  if (err) return pendingEntry.reject(err);
  pendingEntry.resolve(results.length > 1 ? results : results[0]);
}

function invokeClientMethod(state, prop, args, pendingEntry, preconfiguredSeek) {
  const orig = state.client[prop];
  if (!pendingEntry.isReplyMethod) {
    orig.call(state.client, ...args);
    if (!preconfiguredSeek) pendingEntry.resolve();
    return;
  }
  orig.call(state.client, ...args, (err, ...results) => {
    handleReplyCallback(state, pendingEntry, err, results);
  });
}

function dispatchRequest(state, prop, args, preconfiguredSeek = null) {
  const isReply = REPLY_METHODS.has(prop);
  let resolvePromise, rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  const initialSeq = state.client.seq_num;
  const reqKey = `${initialSeq}_${++state.requestIdCounter}`;
  const pendingEntry = {
    key: reqKey,
    seq: initialSeq,
    seq16: initialSeq !== undefined ? initialSeq % 65536 : 0,
    isReplyMethod: isReply,
    resolve: resolvePromise,
    reject: rejectPromise,
    seekPredicate: preconfiguredSeek ? preconfiguredSeek.predicate : null,
    timeoutTimer: null
  };

  invokeClientMethod(state, prop, args, pendingEntry, preconfiguredSeek);

  const reqSeq = state.client.seq_num;
  promise.seq = reqSeq;
  pendingEntry.seq = reqSeq;
  pendingEntry.seq16 = reqSeq !== undefined ? reqSeq % 65536 : 0;

  if (reqSeq !== undefined && (isReply || preconfiguredSeek)) {
    state.pendingRequests.set(reqKey, pendingEntry);
  }

  attachSeekBuilder(state, promise, pendingEntry);

  if (preconfiguredSeek && preconfiguredSeek.timeoutMs > 0) {
    promise.seekResponsePacket(preconfiguredSeek.predicate, preconfiguredSeek.timeoutMs);
  }

  return promise;
}

function wrapClientMethod(state, target, prop, preconfiguredSeek = null) {
  const orig = target[prop];
  if (typeof orig !== 'function') return orig;
  if (SYNC_METHODS.has(prop)) return orig.bind(target);
  return (...args) => dispatchRequest(state, prop, args, preconfiguredSeek);
}

function createSeekProxy(state, target, predicate, timeoutMs = 5000) {
  return new Proxy(target, {
    get(subTarget, subProp) {
      return wrapClientMethod(state, subTarget, subProp, { predicate, timeoutMs });
    }
  });
}

function wrapPromiseXClient(client) {
  if (typeof client.setMaxListeners === 'function') {
    client.setMaxListeners(100);
  }
  const state = {
    client,
    requestIdCounter: 0,
    pendingRequests: new Map()
  };

  client.on('event', (ev) => processIncomingPacket(state, 'event', ev, ev.seq));
  client.on('error', (err) => processIncomingPacket(state, 'error', err, err.seq));

  return new Proxy(client, {
    get(target, prop) {
      if (prop == 'barrier') {
        return () => dispatchRequest(state, 'GetInputFocus', []).then(() => {});
      }
      if (prop == 'seekResponsePacket') {
        return (predicate, timeoutMs = 5000) => createSeekProxy(state, target, predicate, timeoutMs);
      }
      return wrapClientMethod(state, target, prop);
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
