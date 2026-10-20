// intent-dispatcher.js for cool-service-lighter
const { spawn } = require('child_process');
const xintent = require('../x11-promises/xintent');
const { Logger, alStorage } = require('../server-tools');
const logger = new Logger({ module: 'intent-dispatcher' });

async function handleClientMessageEvent({
  ev,
  X,
  lighterWin,
  atoms: {
    xintentIntentV0Atom,
    xintentEventV0Atom,
    xaudioPlaySoundBlobAtom,
    xaudioPrefetchSoundBlobAtom,
    xaudioPlayStreamAtom,
    xaudioControlStreamAtom,
    xaudioSeekStreamAtom,
    xblobBroadcastAtom,
    xblobDestructorAtom,
    xblobCreateResponseAtom,
    xintentDataAtom,
  },
  packageRegistry,
  pickFiles,
  xaudioNode,
  trackChild,
}) {
  if ((ev.type === 33 || ev.name === 'ClientMessage') && ev.wid === lighterWin) {
    alStorage.run(
      {
        values: {
          msgType: ev.message_type,
          seq: ev.seq,
        },
        timers: {
          start: new Date()
        }
      },
      async () => {
        try {
          if (ev.message_type == xintentIntentV0Atom || ev.message_type == xintentEventV0Atom) {
            const xintentIntent = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
            const payload = xintentIntent.payload;
            const intentName = payload?.intent || payload?.action || payload?.event || (payload?.data && typeof payload.data === 'object' ? (payload.data.intent || payload.data.action || payload.data.event) : undefined);
            logger.setContext({
              intent: intentName,
              sender: xintent.widString(xintentIntent.senderWin),
              channel: xintentIntent.channel,
            });

            if (intentName === "sys.Launch") {
              const pakName = payload.package || (payload.data && payload.data.package);
              const pkg = packageRegistry[pakName];
              const intendedIntent = payload.intendedIntent || (payload.data && payload.data.intendedIntent);
              const intent = pkg ? pkg.intents[intendedIntent] : undefined;
              logger.setContext({ package: pakName, intendedIntent: intendedIntent });
              logger.info(`Got request to load ${pakName} for ${intendedIntent}`, intent);

              const proc = spawn(intent.exec, { shell: true, cwd: pkg._path || process.cwd(), stdio: 'inherit' });
              trackChild(proc);
              proc.on('error', err => {
                logger.error(`Failed to launch service:`, err);
              });
            }
            else if (intentName === "fs.PickFilePath") {
              await pickFiles.pickFilePath(xintentIntent);
            }
            else if (intentName === "fs.PickFile") {
              await pickFiles.pickFile(xintentIntent);
            }
            else if (["xaudio.PlaySoundBlob", "XAudioPlaySoundBlob", "XAudioPlaySoundBlobV0", "XAudioPlayV0", "XAudioPlay", "xaudio.Play"].includes(intentName)) {
              await xaudioNode.playSoundBlob(payload, xintentIntent.senderWin, xintentIntent.dataBlob, xintentIntent.channel);
            }
            else if (["xaudio.PrefetchSoundBlob", "XAudioPrefetchSoundBlob", "XAudioPrefetchSoundBlobV0", "XAudioPrefetch"].includes(intentName)) {
              await xaudioNode.prefetchSoundBlob(payload, xintentIntent.dataBlob);
            }
            else if (["xaudio.PlayStream", "PlayStream", "XAudioPlayStreamV0"].includes(intentName)) {
              await xaudioNode.playStream(payload, xintentIntent.senderWin, xintentIntent.dataBlob, xintentIntent.channel);
            }
            else if (["xaudio.ControlStream", "ControlStream", "XAudioControlStreamV0", "XAudioControlV0", "XAudioControl", "xaudio.Control"].includes(intentName)) {
              await xaudioNode.controlStream(payload, xintentIntent.channel, xintentIntent.controlWord);
            }
            else if (["xaudio.SeekStream", "SeekStream", "XAudioSeekStreamV0", "XAudioSeekV0"].includes(intentName)) {
              await xaudioNode.seekStream(payload);
            }
            else {
              logger.warn("unknown intent", intentName);
              return;
            }
          }
          else if (ev.message_type == xaudioPlaySoundBlobAtom) {
            const { payload, senderWin, dataBlob, channel } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
            logger.setContext({ intent: 'xaudio.Play' });
            await xaudioNode.playSoundBlob(payload, senderWin, dataBlob, channel);
          }
          else if (ev.message_type == xaudioPrefetchSoundBlobAtom) {
            const { payload } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
            logger.setContext({ intent: 'xaudio.PrefetchSoundBlob' });
            await xaudioNode.prefetchSoundBlob(payload);
          }
          else if (ev.message_type == xaudioPlayStreamAtom) {
            const { payload, senderWin } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
            logger.setContext({ intent: 'xaudio.PlayStream' });
            await xaudioNode.playStream(payload, senderWin);
          }
          else if (ev.message_type == xaudioControlStreamAtom) {
            const { payload, channel, controlWord } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
            logger.setContext({ intent: 'xaudio.ControlStream' });
            await xaudioNode.controlStream(payload, channel, controlWord);
          }
          else if (ev.message_type == xaudioSeekStreamAtom) {
            const { payload } = await xintent.parseXIntentIntentV0(X, xintent.routerWin, ev, { unlinkPayloadBlob: false });
            logger.setContext({ intent: 'xaudio.SeekStream' });
            await xaudioNode.seekStream(payload);
          }
          else if (ev.message_type == xblobBroadcastAtom) {
            const frame = xintent.parseXBlobBroadcastFrame(X, xintent.routerWin, ev);
            logger.setContext({ event: 'XBLOB_BROADCAST', blob: xintent.widString(frame.blob) });
            await pickFiles.xblobBroadcast(frame);
          }
          else if (ev.message_type == xblobDestructorAtom) {
            const frame = xintent.parseXBlobDestructorFrame(X, xintent.routerWin, ev);
            logger.setContext({ event: 'XBLOB_DESTRUCTOR', blob: xintent.widString(frame.blob) });
            await pickFiles.xblobDestructor(frame);
          }
          else if (ev.message_type == xblobCreateResponseAtom || ev.message_type == xintentDataAtom) {
            return;
          }
          else {
            logger.error(`got unknown message type atom ${ev.message_type}`);
          }
        } catch (err) {
          logger.error(`Error processing ClientMessage event:`, err);
        }
      }
    );
  }
}

module.exports = {
  handleClientMessageEvent,
};
