const x11 = require('x11');

function wrapPromiseXClient(X) {
  return new Proxy(X, {
    get(target, prop) {
      // Exclude EventEmitter methods from being promisified
      if (typeof target[prop] === 'function' && !['on', 'once', 'removeListener', 'emit', 'AllocID'].includes(prop)) {
        return (...args) => new Promise((resolve, reject) => {
          target[prop](...args, (err, ...results) => {
            if (err) return reject(err);
            resolve(results.length > 1 ? results : results[0]);
          });
        });
      }
      return target[prop];
    }
  });
}

x11.createClientWithPromises = (options = {}) => {
  return new Promise((resolve, reject) => {
    x11.createClient(options, (err, display) => {
      if (err) return reject(err);
      
      const X = wrapPromiseXClient(display.client);
      
      // Return both proxied X client and screen display info
      resolve({
        X,
        rawX: display.client, // exposed for raw EventEmitter listeners
        display,
        root: display.screen[0].root
      });
    });
  });
};

module.exports = x11;