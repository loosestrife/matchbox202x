// xsecure.js
// like iptables or aws waf.  deep packet inspecting firewall

const fs = require('fs');
const {atoms, widString} = require('../util/xintent');
const {X, root, routerWin} = require('./index.js');

const authentication = {};
const rules = [
  {action: 'XIntent.sys.RerouteIntent', user: 'IntentRerouter', policy: 'accept'},
  {action: 'XIntent.sys.RerouteIntent', user: '*', policy: 'drop'},
];

const checkXSecurePolicy = async (context, parsed, ev) => {
  let user;
  if(context.source.window){
    user = 'window';
    // TODO: make the x11 npm module return the BadWindow to the await here
    const prop = await X.GetProperty(0, context.source.window, atoms._NET_WM_PID, atoms.CARDINAL, 0, 100000000);
    if(prop && prop.data){
      context.source.pid = prop.data.readUInt32LE(0);
      context.source.cli = fs.readFileSync(`/proc/${context.source.pid}/cmdline`);
      // todo: determine if quack.exe sent the request and give it authentication 'quack.exe'
      user = authentication[context.source.cli] || user;
    }
  } else {
    user = 'rando';
  }
  console.log('checking security policy with context', context);
  let policy = 'accept';
  for(const rule of rules){
    if(rule.action == context.action){
      if(rule.user == user){
        policy = rule.policy;
        break;
      }
    }
  }
  return policy;
};

const globMatch = (pattern, s) => {
  const regexPattern = '^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
    + '$';
  return new RegExp(regexPattern).test(s);
};

module.exports = {
  authentication,
  rules,
  checkXSecurePolicy,
};