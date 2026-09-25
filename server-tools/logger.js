const async_hooks = require('async_hooks');
const crypto = require('crypto');
const alStorage = new async_hooks.AsyncLocalStorage();

let projectName = undefined;

const shortTimestamp = () => {
  const d = new Date();
  return [d.getHours().toString().padStart(2, '0'),
    ':', d.getMinutes().toString().padStart(2, '0'),
    ':', d.getSeconds().toString().padStart(2, '0'),
    '.', d.getMilliseconds().toString().padStart(3, '0')].join('');
};
const formatDuration = (x) => {
  const cutDown = (m) => {
    const y = x % m;
    x = Math.floor(x / m);
    return y;
  }
  const segs = [cutDown(1000), cutDown(60), cutDown(60), cutDown(24), x].reverse();
  const pad = [0, 2, 2, 2, 3];
  const seps = [':', ':', ':', '.'];
  let started = false;
  const out = [];
  segs.forEach((seg, i) => {
    if (seg || started) {
      if (started || i == segs.length - 1) {
        out.push(seps[i - 1]);
      }
      out.push(seg.toString().padStart(pad[i], '0'));
      started = true;
    }
  })
  return out.join('') || '0';
};
const colors = {
  error: 1,
  warn: 3,
  info: 2,
  debug: 6,
  trace: 5
};
const levelOffsets = {
  error: 90,
  warn: 90,
  info: 30,
  debug: 30,
  trace: 30
};
let loggerKeys = {};
class Logger {
  constructor({module}){
    this.module = module;
  }
  keys = function(o) {
    Object.assign(loggerKeys, o);
    return this
  }
  log = function(level, ...args) {
    let msg;
    if (typeof args[0] == 'string') {
      msg = args.shift();
    } else {
      msg = '';
    }
    const store = alStorage.getStore();
    if (store) {
      Object.assign(loggerKeys, store.values);
      for (const t in store.timers) {
        loggerKeys[t] = formatDuration(new Date() - store.timers[t]);
      }
    }
    console.log(
      `\x1b[${
        90 + colors[level]}m[${shortTimestamp()} ${level.padEnd(5)}] \x1b[${levelOffsets[level] + colors[level]}m${projectName?projectName+':':''}${this.module}: ${msg}\x1b[0m`,
      ...args,
      ...Object.keys(loggerKeys).map(k => ` [${k}=${loggerKeys[k]}]`)
    );
    loggerKeys = {};
  }
  error = function(...args) {this.log('error', ...args); return args[0]}
  warn  = function(...args) {this.log('warn' , ...args); return args[0]}
  info  = function(...args) {this.log('info' , ...args); return args[0]}
  debug = function(...args) {this.log('debug', ...args); return args[0]}
  trace = function(...args) {
    if(process.env.LOGGER_TRACE_MODULES){
      if(process.env.LOGGER_TRACE_MODULES.split(',').includes(this.module)){
        this.log('trace', ...args);
        return args[0]
      }
    }
  }
  assert = function(assertion, message, level) {
    if (!assertion) {
      if (level) {
        if (typeof(level) == 'string'){
          this[level](message);
        } else {
          const x = new Error(message);
          x.code = level;
          throw x;
        }
      } else {
        throw new Error(message);
      }
    }
  }
  setProjectName = function(name){
    projectName = name;
  }
}

const loggerMiddleware = (req, res, next) => {
  req.reqId = crypto.randomUUID();
  alStorage.run(
    {
      values: {
        ip: req.ip,
        method: req.method,
        url: req.originalUrl,
        reqId: req.reqId,
      },
      timers: {
        start: new Date()
      }
    },
    () => next()
  );
};

module.exports = {
  alStorage,
  loggerMiddleware,
  Logger,
};