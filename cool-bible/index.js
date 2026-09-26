#!/usr/bin/env node
const fs = require('fs');
const xintent = require('../x11-promises/xintent');
const x11 = require('../x11-promises/x11-promises');
const bible = require('./bible.js');

const {
  connectToRouter,
  createClientWindow,
  parseXIntentIntentV0,
  XBlobCreate,
  sendXIntentEventV0,
  atoms,
  widString,
} = xintent;


async function startDaemon() {
  const { X, root } = await x11.createClientWithPromises();
  await connectToRouter(X, root);

  if (!xintent.routerWin) {
    console.error('[cool-bible] Error: Could not connect to XINTENT router.');
    process.exit(1);
  }

  const serviceWin = await createClientWindow(X, root, 'ui.CoolBible');

  // Register required X11 atoms
  const atomList = [
    'XINTENT_MATCHBOX_TOML',
    'STRING',
    'UTF8_STRING',
    'text/plain',
  ];

  await Promise.all(
    atomList.map(async (name) => {
      atoms[name] = await X.InternAtom(false, name);
    })
  );

  // Advertise ui.TextProcess intent capability to Matchbox Router
  const matchboxToml = fs.readFileSync(__dirname + '/matchbox.toml', 'utf-8');

  X.ChangeProperty(
    0,
    serviceWin,
    atoms.XINTENT_MATCHBOX_TOML,
    atoms.STRING,
    8,
    Buffer.from(matchboxToml)
  );

  console.log(`[cool-bible] Online on window ${widString(serviceWin)} (Router: ${widString(xintent.routerWin)})`);

  // Handle incoming XIntent frames
  X.on('event', async (ev) => {
    if (ev.type === 33 && ev.message_type === atoms.XINTENT_INTENT_V0) {
      try {
        const { senderWin, payload, channel } = await parseXIntentIntentV0(X, xintent.routerWin, ev);

        if (payload.intent === 'ui.TextProcess') {
          console.log(`\n[cool-bible] Received ui.TextProcess intent from ${widString(senderWin)} on channel ${channel} for ref: "${payload.ref}"`);

          const resultText = bible.lookupReference(payload.text);


          await sendXIntentEventV0(X, xintent.routerWin, {
            senderWin: serviceWin,
            channel,
            payload: {
              event: 'ui.TextProcessResponse',
              text: resultText,
              disposition: 'final',
            },
          });

          console.log(` -> Sent ui.TextProcessResponse back to channel ${channel}`);
        }
      } catch (err) {
        console.error('[cool-bible] Error handling intent:', err);
      }
    }
  });
}

startDaemon().catch((err) => {
  console.error('[cool-bible] Fatal error:', err);
  process.exit(1);
});