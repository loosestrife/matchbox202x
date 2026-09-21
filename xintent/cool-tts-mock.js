// cool-tts-mock.js
const x11 = require('./util/x11-promises');
const xintent = require('./util/xintent');

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
  const routerWin = await xintent.connectToRouter(X, root);
  const ttsWin = X.AllocID();

  await X.CreateWindow(
    ttsWin, root,
    0, 0, 1, 1, 0, 0, 0, 0,
    { eventMask: x11.eventMask.PropertyChange }
  );

  const xintentAtom = await X.InternAtom(true, 'XINTENT');
  const xintentV0Atom = await X.InternAtom(true, 'XINTENT_INTENT_V0');

  const wmClassAtom = await X.InternAtom(false, 'WM_CLASS');
  const wmPidAtom = await X.InternAtom(false, '_NET_WM_PID');
  const stringAtom = await X.InternAtom(false, 'STRING');
  const xintentMatchboxTomlAtom = await X.InternAtom(false, 'XINTENT_MATCHBOX_TOML');

  X.ChangeProperty(0, ttsWin, wmClassAtom, stringAtom, 8, Buffer.from('cool-tts\0cool-tts\0'));
  X.ChangeProperty(0, ttsWin, xintentMatchboxTomlAtom, stringAtom, 8, Buffer.from(matchbox_toml));
  X.ChangeProperty(0, ttsWin, )


  rawX.on('event', async (ev) => {
    if (ev.name === 'ClientMessage' && ev.wid === ttsWin && ev.message_type == xintentV0Atom) {
      const intentObject = await xintent.parseXIntentIntentV0(X, ev);
      console.log(`[cool-tts] Processing TTS for: "${intentObject.payload.text}"`);

      // 1. Generate Mock Binary Blob (e.g., PCM audio or response metadata)
      const replyBlob = Buffer.from(`TTS_AUDIO_PCM_DATA_BLOB_FOR_${payload.text}`);
      const replyXBlob = await xintent.XBlobCreate(X, {
        blob: replyBlob
      });
      xintent.sendXIntentIntentV0(X, {
        targetWin: routerWin,
        senderWin: ttsWin,
        channel: intentObject.channel,
        payload: {
          intent: 'ui.TextToSpeechResponse',
          blob: replyXBlob,
        }
      });
      xintent.XBlobUnlink(X, {
        blob: replyXBlob
      });
    }
  });

  console.log('[cool-tts] Service ready.');
}

startTTSService().catch(console.error);