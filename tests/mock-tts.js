// mock-tts.js - Standalone Mock Text-To-Speech Service (mock-tts-server)
const x11 = require('../x11-promises/x11-promises');
const xintent = require('../x11-promises/xintent');
const {
  connectToRouter,
  createClientWindow,
  parseXIntentIntentV0,
  XBlobCreate,
  sendXIntentEventV0,
  atoms,
  widString,
} = xintent;

function generateWavBuffer(textStr) {
  const pcmLength = 100;
  const pcmData = Buffer.alloc(pcmLength);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);      // PCM format
  header.writeUInt16LE(1, 22);      // Mono
  header.writeUInt32LE(22050, 24);  // 22.05 kHz
  header.writeUInt32LE(44100, 28);  // Byte rate
  header.writeUInt16LE(2, 32);      // Block align
  header.writeUInt16LE(16, 34);     // Bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcmLength, 40);
  return Buffer.concat([header, pcmData]);
}

async function startMockTtsServer() {
  const { X, root } = await x11.createClientWithPromises();
  await connectToRouter(X, root);

  if (!xintent.routerWin) {
    console.error('[mock-tts-server] Error: Could not connect to XINTENT router.');
    process.exit(1);
  }

  const ttsWin = await createClientWindow(X, root, 'mock-tts-server');

  const matchboxToml = `
[app]
id = "mock-tts-server"

[intents."ui.TextToSpeech"]
invocation = "X11"
`;

  X.ChangeProperty(
    0,
    ttsWin,
    atoms.MATCHBOX_TOML,
    atoms.STRING,
    8,
    Buffer.from(matchboxToml)
  );

  console.log(`[mock-tts-server] Online on window ${widString(ttsWin)} (Router: ${widString(xintent.routerWin)})`);

  X.on('event', async (ev) => {
    if (ev.type === 33 && ev.message_type === atoms.XINTENT_INTENT_V0) {
      try {
        const { senderWin, payload, channel } = await parseXIntentIntentV0(X, xintent.routerWin, ev);

        if (payload.intent === 'ui.TextToSpeech' || payload.action === 'ui.TextToSpeech') {
          const textInput = payload.text || 'TTS E2E Sample Text';
          console.log(`\n[mock-tts-server] Received ui.TextToSpeech intent: "${textInput}" (channel: ${channel})`);

          const wavBuf = generateWavBuffer(textInput);
          const wavBlob = await XBlobCreate(X, xintent.routerWin, ttsWin, {
            xblobType: 'Blob',
            type: 'audio/wav',
            size: wavBuf.length,
            data: wavBuf,
            _dataType: 'binary',
          });

          await sendXIntentEventV0(X, xintent.routerWin, {
            senderWin: ttsWin,
            channel,
            controlWord: 2, // FIN
            dataBlob: wavBlob,
            payload: {
              event: 'ui.TextToSpeechResponse',
              disposition: 'final',
              status: 200,
            },
          });

          console.log(` -> Responded to ui.TextToSpeech with WAV audio blob 0x${wavBlob.toString(16)}`);
        }
      } catch (err) {
        console.error('[mock-tts-server] Error handling TTS intent:', err.message);
      }
    }
  });
}

startMockTtsServer().catch((err) => {
  console.error('[mock-tts-server] Startup error:', err);
  process.exit(1);
});
