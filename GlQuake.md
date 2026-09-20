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


#### SUN MICROSYSTEMS — LAB NOTE
#### From: Zhang "GLM" Peng, Stream Transport — I own xoss, you know where my office is
#### Date: 31 Oct 1997
#### Subject: Re: your glquake note — the other ten tracks (SPEC-1995-XBLOB-002-REV5)
#### Filed: on Wenfeng's desk, next to his plant, which I have been watering

Wenfeng —

Your note got the nailgun across the hall. It didn't get Trent. `+bgmvolume 0` with the disc in your drawer is half a demo, and the missing half is the reason everyone under thirty thinks "multimedia over ssh -X" is a punchline. While you were in Tahoe I put REV5 on sunacrosshall and the hallway 7300. Don't merge until you're back — you get the red pen on the attribute fields.

The discipline in your note (cookie rides the channel, no daemon, thin shim, game never recompiled) is why the CD path bolted on in a week instead of a quarter.

And it's still `xoss ./glquake`. You just have to put the disc in the Ultra 5's Toshiba first. Yes, with your legs. That's the one syscall the 90's future still can't do for you.
What changed while you were gone

The complete protocol delta:

* XBlobAttributes grows uint64_t start_offset and uint64_t length. A track is a window onto the disc's LBA space. The disc is just a vnode with terrible seek times.
* XBlobCreateFromFD() — you asked for fd semantics in your last message; it was two hours. cdaud hands us a path anyway, so we mostly don't need it.
* SeekStream takes a Blob ID and a 64-bit byte offset. The REV4 table said "SHM ID" for a CDDA seek — that was a copy-paste from the SHM transport section. Fixed.
* Opcode 0x04 is now spelled SetClientVolume. We all stared at "SetVlientVolume" for three weeks. Fixed.
* One new XSetting, XAudio/CDRingSeconds (default 20). It's the knob, it's in the root window, and the admin can xprop it like everything else in this system.

Sixteen bytes of struct, one XSetting, two typos. Everything else is a STREAMS module and an interposer. None of this was invented here.
The part that isn't a protocol: cdaud(7M)

* cdaud pushes onto the cd driver, parses the TOC at open, and presents per-track minors: /dev/cd0/cd0t2 … t11. The Finder has mounted audio CDs as track files since System 7 and SGI's cdfs since '94. Your instinct on the device node was right.
* Data path is READ CD (0xBE) through uscsi(7I) passthrough — identical for the SBus SunCD in the Ultra 2 and the ATAPI Toshiba in the Ultra 5, because sd hides the difference, which is the point.
* The module owns the clock: putq/getq on a 13.3 ms timeout, 16-sector mblks, 75 sectors/s plus 5% margin. One SET CD SPEED (0xBB) at push, something sedate — at full CAV the disc is a 5,000 rpm gyroscope, the desk walks, and DAE above 4× on a '97 mechanism gives you jitter chirps you can hear. The 24x is for installing Office. Listening is 1×.
* The reservoir: 4 MiB ring between the mechanism and the wire. ~23 seconds of Reznor.

```text
[24x Toshiba] --uscsi READ CD--> [cdaud ring, 4 MiB] --XBLOB chan 7, IMA 4:1--> ssh --> [Sound Manager]
   paced 75 sec/s      control rides the X socket: PlayStream / ControlStream / StreamEnd
```

Invariant: the Mac's jitter buffer fills from memory on the Ultra, or it doesn't fill. If a ClientMessage ever reaches a stepper motor, that's a layering violation and someone's badge number.
The drill
```sh
% ssh -X sunacrosshall
sunacrosshall% cdaud --toc /dev/cd0
  track  start LBA   length   format
  1      0           230 MB   data (2048)   <- the game; don't touch
  2      118104      4:36     audio (2352)
  ...
  11     ...         1:12     audio (2352)
sunacrosshall% xoss ./glquake
```

That's it. `$DISPLAY` inherited, cookie inherited, no daemon. id's `cd_linux.c` ioctls are in the binary — `CDROMPLAYTRK` got `ENOTTY` on half the drives of the era and everyone's soundtrack quietly died — so the interposer owns them now, same as it owns `/dev/audio`. Quake doesn't get recompiled, which remains the whole sales pitch.
glquake does | xoss does | mechanism cost | hidden under
---
open("/dev/cdrom") | parse TOC, spin up now |	2–4 s |	game connect — disc is lit before worldspawn arrives
CDROMPLAYTRK (worldspawn) |	XBlobCreate(ReadableStream, /dev/cd0/cd0t(track+1), block 250ms) + PrefetchSoundBlob + PlayStream(0x10)	| one seek, 100–300 ms | the bsp load, which already stalls for seconds
CDROMPAUSE/RESUME | ControlStream(0/1) on the main X socket | none — Mac stops consuming; module parks at ring high-water | under 23 s: seamless. Over: you pay spin-up, and you were in the console
CDROMSUBCHNL polling | synthesized from the ring write cursor | none — status never reaches the mechanism either | never
track end | lead-out → xa.StreamEnd, drive parks| — | the silence id shipped on Linux anyway
exit | both blobs XBlobUnlink | refcount 0, park | ESC

The off-by-one is ours now: mixed-mode disc, track 1 is the data session, and e1m1 asks for cdtrack 3, which is disc track 4. (strings e1m1.bsp | grep cdtrack if you doubt it.) If you hear a modem fed through a woodchipper, the TOC parse mapped track 1. Fix the parse, not the player.
Under the hood

* Quake still mixes its own 8 channels and writes one MediaStream at 50 ms blocks, exactly per your note. The CD never touches Quake's mixer — second producer, ReadableStream at 250 ms. Latency is a budget: the shotgun spends 50 ms of it, Trent can spend 250 and nobody frags worse for it.
* It's the analog CD-audio cable of a '96 sound card, reborn — except the cable is one ssh TCP connection. One control channel, two data channels. When glquake dies, the socket closes, both blobs unlink, the drive parks. No unregister protocol, no keepalives, no ghosts. When IS kicks the hall hub, Trent stops mid-verse. Correct failure mode.
* Wire codec: audio/x-qt-imadpcm;4:1 on both streams — CD audio is 176.4 kB/s big-endian 16-bit, IMA takes it to 44.1 kB/s and the game stream to ~22, so the Mac keeps exactly one decode path. Total ~70 kB/s; FastEthernet doesn't notice, and even the shared 10baseT hub survives, though one collision burst still underruns the 50 ms blocks, which is nothing new. Still no Fraunhofer component on the office PO, so MP3 remains a theory. CDDA is big-endian, the X wire is big-endian, AIFF is big-endian, Sound Manager wants big-endian — the only machine in the building that would need a bswap is a Wintel box, and it's not invited.
* The only mixer in the entire story is Sound Manager, on the node with the speaker. Section 8, as designed. Keep XAudio/MixingMode off EXCLUSIVE or the Finder's alert beep and Trent will lock the device like it's 1992.

Verify it
```sh
sunacrosshall% xblob-ls --format=json
{ "blobId": "0xcafebabe", "type": "MediaStream",
  "producer": { "process": "glquake", "endpoint": "/dev/audio0" }, ... }
{ "blobId": "0xfeedface", "type": "ReadableStream", "block_size_ms": 250,
  "producer": { "node": "sunacrosshall:0.0", "process": "cdaud/xoss",
                "endpoint": "uscsi READ CD, paced 75 sectors/s" },
  "consumers": [ { "node": "mac7300:0.0", "process": "XAudioNode",
                   "transport": "SSH_MUX chan 7, IMA 4:1" } ] }

sunacrosshall% iostat -x 5 cd0
    r/s   w/s   kr/s   %b
    4.7   0.0  172.3  100
```

Five reads a second, busy pinned, boring. truss -t open,ioctl the game: every audio syscall ends in a write to the X socket. The drive should be the least interesting device in the building — tell the server-room guys that when they see the light doing a slow heartbeat, and mean it.

Smoke test before demoing: `xoss --cd-test 4` puts ten seconds of disc track 4 on your `$DISPLAY` with no Quake involved.

#### For the 3:00
`xaudio-tee` both streams to DAT — this time with the bass line — and play it for the server room. First annex of the music stream popped the `ClientInterconnectPolicy` prompt on the Mac; `allowAndStore` it once and the tee is quiet forever. The nail ammo boxes have said NiN since '96. The soundtrack finally catches up to the ammunition.

Ten tracks, two streams, one TCP connection, zero daemons, no recompile. That's the full 90's future.

p.s. Quote your transcode specs. --transcode audio/mp3;64k unquoted gets shell-split and the terminal tries to exec 64k. This will bite the first hundred users. Filing it against your note, not you.