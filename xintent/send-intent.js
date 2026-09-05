// send-intent.js
const x11 = require('./util/x11-promises');
const {connectToRouter, sendXintentIntentV0, atoms} = require('./util/xintent');

async function sendIntent() {
  const { X, root } = await x11.createClientWithPromises();
  const routerWin = await connectToRouter(X, root);
  if(!routerWin){
    console.log("no router");
    return;
  }
  console.log(`[sender] Found router window ID: 0x${routerWin.toString(16)}`);
  await sendXintentIntentV0(X, {
    targetWin: routerWin,
    senderWin: 0,
    txId: 67,
    payload: {
      intent: 'ui.TextToSpeech',
      text: 'Direct window IPC works!'
    },
  });
  console.log('[sender] Direct ClientMessage dispatched!');  
  setTimeout(() => process.exit(0), 100);
}

sendIntent().catch(console.error);