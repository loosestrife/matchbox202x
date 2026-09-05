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

function wrapPromiseXClient(X) {
  return new Proxy(X, {
    get(target, prop) {
      const orig = target[prop];
      if (typeof orig === 'function' && REPLY_METHODS.has(prop)) {
        return (...args) => new Promise((resolve, reject) => {
          orig.call(target, ...args, (err, ...results) => {
            if (err) return reject(err);
            resolve(results.length > 1 ? results : results[0]);
          });
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
      display.client.on('error', console.warn);
      resolve({
        X,
        rawX: display.client,
        display,
        root: display.screen[0].root
      });
    });
  });
};

module.exports = x11;