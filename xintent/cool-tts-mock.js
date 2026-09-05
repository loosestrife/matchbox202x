// cool-tts-mock.js
const x11 = require('./x11-promises');
const xintent = require('./xintent');

const matchbox_toml = `
[intents."ui.TextToSpeech"]
invocation = "X11"
execDir = "."
exec = "bun cool-tts-mock.js"
env = {}
args = []
`;

async function startTTSService() {
  const { X, rawX, root } = await x11.createClientWithPromises();
  const { routerWin, xintentV0Atom } = await xintent.connectToRouter(X, root);
  const ttsWin = X.AllocID();

  await X.CreateWindow(
    ttsWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  const xintentAtom = await X.InternAtom(false, 'XINTENT');
  const xintentDataAtom = await X.InternAtom(false, 'XINTENT_DATA');
  const xintentReplyAtom = await X.InternAtom(false, 'XINTENT_REPLY');
  const wmClassAtom = await X.InternAtom(false, 'WM_CLASS');
  const stringAtom = await X.InternAtom(false, 'STRING');
  const xintentMatchboxTomlAtom = await X.InternAtom(false, 'XINTENT_MATCHBOX_TOML');

  X.ChangeProperty(0, ttsWin, wmClassAtom, stringAtom, 8, Buffer.from('cool-tts\0cool-tts\0'));
  X.ChangeProperty(0, ttsWin, xintentMatchboxTomlAtom, stringAtom, 8, Buffer.from(matchbox_toml));


  rawX.on('event', async (ev) => {
    if (ev.name === 'ClientMessage' && ev.wid === ttsWin) {
      const prop = await X.GetProperty(0, ttsWin, xintentDataAtom, stringAtom, 0, 1000);
      if (!prop || !prop.data) return;

      const payload = JSON.parse(prop.data.toString());
      console.log(`[cool-tts] Processing TTS for: "${payload.text}"`);

      // 1. Generate Mock Binary Blob (e.g., PCM audio or response metadata)
      const replyBlob = Buffer.from(`TTS_AUDIO_PCM_DATA_BLOB_FOR_${payload.text}`);

      // 2. Write the blob to the Router's Window (using routerWin ID sent in request)
      const routerWin = ev.data[0];
      await X.ChangeProperty(0, routerWin, xintentReplyAtom, stringAtom, 8, replyBlob);
      const replyEv = Buffer.alloc(32);
      replyEv.writeInt8(33, 0);               // ClientMessage
      replyEv.writeInt8(32, 1);               // 32-bit format
      replyEv.writeUInt32LE(routerWin, 4);    // Target Window
      replyEv.writeUInt32LE(xintentReplyAtom, 8); // Reply Atom
      replyEv.writeUInt32LE(ttsWin, 12);      // Sender Window ID

      await X.SendEvent(routerWin, false, x11.eventMask.NoEventMask, replyEv);
      console.log('[cool-tts] Reply blob sent back to Router!');
    }
  });

  console.log('[cool-tts] Service ready.');
}

startTTSService().catch(console.error);