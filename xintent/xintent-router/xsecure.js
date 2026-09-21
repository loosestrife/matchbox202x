// xaudio.js
const fs = require('fs');
const {atoms, widString} = require('../util/xintent');
const {X, root, routerWin} = require('./index.js');

const authentication = {};
const authorizations = {};

const checkXSecurePolicy = async (context, parsed, ev) => {
  const prop = await X.GetProperty(0, context.source.window, atoms._NET_WM_PID, atoms.CARDINAL, 0, 100000000);
  if(prop && prop.data){
    context.source.pid = prop.data.readUInt32LE(0);
    context.source.cli = fs.readFileSync(`/proc/${context.source.pid}/cmdline`);
  }
  // todo: determine if quack.exe sent the request and give it authentication string 'quack.exe'
  console.log('checking security policy with context', context);
  // todo: authorize only quack.exe to perform the action XIntent.sys.RerouteIntent
  return 'accept';
};

module.exports = {
  authentication,
  authorizations,
  checkXSecurePolicy,
};