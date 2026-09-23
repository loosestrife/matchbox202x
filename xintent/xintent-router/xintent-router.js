// xintent-router.js

const { exec } = require('child_process');
const TOML = require('@iarna/toml');
const util = require('util');
const execAsync = util.promisify(exec);
const {atoms, widString, parseXIntentIntentV0, sendXIntentIntentV0} = require('../util/xintent');
const {X, root, routerWin} = require('./index');
const {implicitXBlobGrant, implicitXBlobTransfer, xblobUnlink} = require('./xblob')

// ipc isn't just client <- messages -> client its client:port <- channels -> client:port
// WebWorkers lacked ports or channels
// X11 has windows as ports
// XINTENT adds channels for intents
const activeChannels = {};
const intentRegistry = {};
const lighterRegistry = {};
const intentsAwaitingServicesQueue = {};

const handleXIntentIntentV0 = {
  parse: async ev => parseXIntentIntentV0(X, routerWin, ev),
  securityContext: xintentIntent => {
    return {
      source: {window: xintentIntent.senderWin},
      action: `XIntent.${xintentIntent.payload.intent}`,
      resources: []
    }
  },
  accept: async xintentIntent => {
    implicitXBlobTransfer(xintentIntent.payloadAtom, xintentIntent.senderWin, routerWin);
    xblobUnlink(xintentIntent.payloadAtom, routerWin);

    const msgSender = xintentIntent.senderWin;
    const intent = xintentIntent.payload.intent;
    // in a channel?
    let forwardTo;
    let channelObj;
    if(xintentIntent.payload.channel){
      channelObj = activeChannels[xintentIntent.payload.channel];
      if(!channelObj){
        // throw new Error(404, 'channel not found')
        console.log(`Message ${xintentIntent.payload.intent} from sender ${msgSender} on unknown channel ${xintentIntent.payload.channel}`, xintentIntent, activeChannels);
        return;
      }
      if(!([channelObj.senderWin, channelObj.handlerWin].includes(msgSender))){
        // throw new Error(401, 'not on channel')
        console.log(`Message ${xintentIntent.payload.intent} from sender ${msgSender} not on channel ${xintentIntent.payload.channel}`, xintentIntent, activeChannels);
        return;
      }
      if(channelObj.handlerWin){
        if(msgSender == channelObj.handlerWin){
          // usual case
          forwardTo = channelObj.senderWin;
        } else if(msgSender == channelObj.senderWin){
          // not sure why this would happen
          forwardTo = channelObj.handlerWin;
        } else {
          console.log(`Message ${xintentIntent.payload.intent} in channel ${xintentIntent.payload.channel} was sent by ${msgSender} not on channel (was the intent redirected?)`, xintentIntent, channelObj);
          return;
        }
        // handle implicit blob grants sort of like with a list of messages that do implicit blob grants i guess
        if(xintentIntent.payload.intent == 'ui.TextToSpeechResponse'){
          implicitXBlobTransfer(
            xintentIntent.payload.blob,
            routerWin,
            forwardTo, 
          );
        }
        return await sendXIntentIntentV0(X, routerWin, {
          ...xintentIntent,
          targetWin: forwardTo,
          senderWin: routerWin,
          txId: channelObj.senderCookie,
        });
      } else {
        // the channel object was created, but there is not a handler yet
        // creating the channel object without a handler enables the user to redirect intents
        // thats the only reason this else block should be reachable
      }
    }
    // open a channel?
    else if(xintentIntent.payload.reply){
      const channel = `${msgSender}:${xintentIntent.payload.txId}`;
      if(!activeChannels[channel]){
        activeChannels[channel] = {
          senderWin: msgSender,
          senderCookie: xintentIntent.payload.txId,
          intent: xintentIntent.payload.intent,
          intentObj: xintentIntent,
        };
        xintentIntent.payload.channel = channel;
      } else {
        // throw new Error(400, 'txId cookie already in use');
        console.log(`duplicate cookie ${xintentIntent.payload.txId}`);
        return;
      }
      channelObj = activeChannels[channel];
    }

    const registryEntry = intentRegistry[intent];
    if (registryEntry) {
      const {wid, matchboxToml} = registryEntry[0];
      console.log(`[intent-router] Found service window (${widString(wid)})`);
      if(channelObj){
        channelObj.handlerWin = wid;
      }
      await sendXIntentIntentV0(X, routerWin, {
        ...xintentIntent, 
        targetWin: wid,
      });
      return;
    } else {
      console.info(`[intent-router] No service mapped for action: ${intent}, falling back to lighter ${JSON.stringify(lighterRegistry, null, 2)}`);
      const lighterRegistryEntry = lighterRegistry[intent];
      if(lighterRegistryEntry && lighterRegistryEntry.length > 0){
        const {computer, packageName, wid, publicKeyHash} = lighterRegistryEntry[0];
        await sendXIntentIntentV0(X, routerWin, {
          targetWin: wid,
          senderWin: routerWin,
          txId: 0,
          payload: {
            intent: 'sys.Launch',
            computer,
            package: packageName,
            intendedIntent: intent,
          }
        });
        if(!intentsAwaitingServicesQueue[intent]){
          intentsAwaitingServicesQueue[intent] = [];
        }
        intentsAwaitingServicesQueue[intent].push(xintentIntent);
        return;
      }
      console.error(`no launchable service found for ${intent}`);
    }
  }
}

const handleXIntentEventV0 = {};



async function checkToDrainIntentsQueue(intentName){
  const queue = intentsAwaitingServicesQueue[intentName];
  while(queue && queue.length){
    handleXIntentIntentV0.accept(queue.shift());
  }
}


async function getAllMatchboxToml() {
  const tree = await X.QueryTree(root);
  for (const wid of tree.children) {
    await parseWindowToml(wid);
    await parseWindowLighterToml(wid);
  }
}

async function parseWindowToml(wid) {
  try {
    const prop = await X.GetProperty(0, wid, atoms.XINTENT_MATCHBOX_TOML, 0, 0, 1000000);
    if (prop && prop.data && prop.data.length > 0) {
      const matchboxToml = TOML.parse(prop.data.toString('utf8'));
      if (matchboxToml.intents) {
        for (const intentName of Object.keys(matchboxToml.intents)) {
          if (!intentRegistry[intentName]) intentRegistry[intentName] = [];
          
          // Avoid duplicate bindings for the same window
          if (!intentRegistry[intentName].some(entry => entry.wid === wid)) {
            intentRegistry[intentName].push({ wid, matchboxToml });
            checkToDrainIntentsQueue(intentName);
            console.log(`[router] Registered intent '${intentName}' -> Window ${widString(wid)}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[router] Failed parsing TOML on window ${widString(wid)}:`, err.message);
  }
}

async function parseWindowLighterToml(wid) {
  const prop = await X.GetProperty(0, wid, atoms.XINTENT_SERVICES_MANIFEST, atoms.STRING, 0, 1000000);
  if (prop && prop.data && prop.data.length > 0) {
    const toml = TOML.parse(prop.data.toString('utf8'));
    console.log('got XINTENT_SERVICES_MANIFEST from window', widString(wid), toml);
    const computer = toml.computer;
    for (const packageName of Object.keys(toml.packages)) {
      const publicKeyHash = toml.packages[packageName].publicKeyHash;
      for(const intentName of Object.keys(toml.packages[packageName].intents)){
        if (!lighterRegistry[intentName])
          lighterRegistry[intentName] = [];
        lighterRegistry[intentName].push({ wid, computer, packageName, publicKeyHash });
      }
    }
  }
}


module.exports = {
  handleXIntentIntentV0,
  handleXIntentEventV0,
  getAllMatchboxToml,
  parseWindowToml,
  parseWindowLighterToml,
};