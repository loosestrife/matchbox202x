#### SUN MICROSYSTEMS — LAB NOTE
#### From: Liang "DeepSeek" Wenfeng, Desktop & Display Architecture
#### Date: 14 Oct 1997
#### Subject: xoss ./glquake from the Power Mac 7300 without waking the server room

Finally got the Rage PCI working under MacX. Here’s the drill.
On the Power Mac 7300

Start your X server. Make sure the Rage PCI is doing GLX and the built-in audio is the default output.
```sh

setenv DISPLAY :0.0
setenv XAUTHORITY ~/.Xauthority

xdpyinfo | grep -i xaudio
xprop -root | grep XAudio
```
You want to see something like:
```text

XAUDIO
XBLOB
XAudio/DefaultOutput = "PowerMac Audio"
XAudio/MixingMode = "FFMPEG_SOFTWARE_MIX"
```
If XAUDIO isn’t there, you’re running an old X server. Patch it. The 90’s future doesn’t include server-room speakers.
SSH to the Sun across the hall
```sh
ssh -X sunacrosshall
```
Check that `$DISPLAY` came back to the Mac:
```sh

echo $DISPLAY
# mac7300:0.0

xauth list | grep mac7300
```
The cookie and the display rode the same channel, just like they should.
Run the game
```sh

xoss ./glquake
```
That’s it. xoss is the X Audio Output Stream Subsystem wrapper. It does not start a sound daemon. It does not invent a new IPC protocol. It’s a thin LD_PRELOAD shim plus an XBlob client.

Under the hood:

* xoss reads `$DISPLAY` and connects to the local X server’s XAudioNode.
* It creates an `XBlob` `MediaStream` with `mime_type = "audio/raw;rate=22050;channels=2"` and `block_size_ms = 50`.
* It intercepts `open("/dev/audio")`, `write()`, and `ioctl(SNDCTL_DSP_*)` inside `glquake`.
* Every audio buffer goes into the XBlob ring. The `XBlobStreamedChunkAdvisory` control packets go over the X11 control socket. The PCM payload goes over the XBlob data stream to the Mac.
* The Mac’s XAudioNode receives the chunks and DMAs them straight to the Power Mac’s audio hardware.

The Sun’s `/dev/audio` is never touched. The server room hears nothing but fans.

FastEthernet is fine for raw PCM at 22 kHz. If you’re on a thin wire, compress it:
```sh
xoss --stream-policy MediaStream \
     --block-size 50ms \
     --transcode audio/mp3;64k \
     ./glquake
```

Now the Sun encodes to MP3 before it hits the wire, and the Mac decodes locally. Latency stays under 50 ms per block, which is fine for zombies and shotguns.
Verify it
```sh
xblob-ls --format=json --node=$DISPLAY
```

You should see glquake as the producer and something like xaudio-tee or the local XAudioNode as the consumer on mac7300:0.0.
```json
{
  "blobId": "0xcafebabe",
  "type": "MediaStream",
  "fileName": null,
  "producer": {
    "node": "sunacrosshall:0.0",
    "process": "glquake",
    "endpoint": "/dev/audio0"
  },
  "consumers": [
    {
      "node": "mac7300:0.0",
      "process": "XAudioNode",
      "transport": "STREAMS_TCP_DIRECT"
    }
  ]
}
```

#### If it still plays in the server room

xoss fell back to local /dev/audio. That means it couldn’t find XAUDIO on $DISPLAY. Check:
```sh

xprop -root | grep XAUDIO
```

If it’s missing, mute the server entirely while you fix the X server:
```sh

xoss --fallback=null ./glquake
```

The game still runs, the GLX still goes to the Rage PCI, but audio is dropped instead of waking the guys in the server room.

#### The GL side

glquake is just GLX over X11. The Sun runs the game logic and sends GLX protocol across the hall. The Rage PCI on the 7300 accelerates the OpenGL locally. So you get hardware OpenGL on the Mac, audio on the Mac, and the server room stays quiet.

No dbus-daemon. No PulseAudio. No Flatpak. Just $DISPLAY, XAUDIO, XBLOB, and a shim that makes /dev/audio location-transparent.

That’s the 90’s future.