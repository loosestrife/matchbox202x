// send-intent.js
const x11 = require('./x11-promises/x11-promises');
const {connectToRouter, createClientWindow, sendXIntentIntentV0, atoms} = require('./x11-promises/xintent');

async function sendIntent() {
  const { X, root } = await x11.createClientWithPromises();
  const win = await createClientWindow(X, root, 'intent sender');
  const routerWin = await connectToRouter(X, root);
  if(!routerWin){
    console.log("no router");
    return;
  }
  console.log(`[sender] Found router window ID: 0x${routerWin.toString(16)}`);
  await sendXIntentIntentV0(X, routerWin, {
    senderWin: win,
    txId: 67,
    payload: {
      intent: 'ui.TextToSpeech',
      text: 'Direct window IPC works!',
      reply: true,
    },
  });
  console.log('[sender] Direct ClientMessage dispatched!');  
  setTimeout(() => process.exit(0), 100);
}

sendIntent().catch(console.error);