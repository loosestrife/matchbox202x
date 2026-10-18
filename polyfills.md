# V0
It takes 0 intelligence to "invent" stuff that everyone already knows exactly how it works and should have existed already.  The hard part is the V0 polyfills, full of insecurity and questionable decisions.

## XMessageFrame
an XClientMessage with
```
|                       XClientMessageEvent                             |
+-----------------------------------------------------------------------+
| type        : ClientMessage                                           |
| window      : Target Window XID                                       |
| message_type: Atom("MESSAGE_TYPE_ATOM")                               |
| format      : 32                                                      |
| data.l[0]   : Sender Window XID                                       |
```

## XChannelFrame
an XMessageFrame with
```
|                       XClientMessageEvent                             |
+-----------------------------------------------------------------------+
| type        : ClientMessage                                           |
| window      : Target Window XID                                       |
| message_type: Atom("MESSAGE_TYPE_ATOM")                               |
| format      : 32                                                      |
| data.l[0]   : Sender Window XID                                       |
| data.l[1]   : txId / channelId                                        |
| data.l[2]   : Channel Control Word (bit 0 for SYN, bit 1 for FIN)     |
```

The initial sender's txId has to be under 16777216 and the server promises to only use numbers 16777216 and up to designate channels.  That way the client's txId will never collide with a server channel number.

On an http bridge, the channel control word is represented as `X-Channel-Control: SYN,FIN`

## XJsonFrame
an XMessageFrame with
```
|                       XClientMessageEvent                             |
+-----------------------------------------------------------------------+
| type        : ClientMessage                                           |
| window      : Target Window XID                                       |
| message_type: Atom("MESSAGE_TYPE_ATOM")                               |
| format      : 32                                                      |
| data.l[0]   : Sender Window XID                                       |
| data.l[1]   : JSON payload XBlob id                                   |
| data.l[2]   : Data XBlob id                                           |
```

## XChannelJsonFrame
an XChannelFrame with
```
|                       XClientMessageEvent                             |
+-----------------------------------------------------------------------+
| type        : ClientMessage                                           |
| window      : Target Window XID                                       |
| message_type: Atom("MESSAGE_TYPE_ATOM")                               |
| format      : 32                                                      |
| data.l[0]   : Sender Window XID                                       |
| data.l[1]   : txId / channelId                                        |
| data.l[2]   : Channel Control Word (bit 0 for SYN, bit 1 for FIN)     |
| data.l[3]   : JSON payload XBlob id                                   |
| data.l[4]   : Data XBlob id                                           |
```

True natwork transparency comes from knowing that your message will be bridged and natted 10 times before it gets to its destination and designing the envelope to be natted.

## Limitations
### Needing a Window
It is not possible to send an xintent without registering a window in XIntent V0, even for fire and forget intents like `ui.Copy`.  This is because XClientMessage is 20 bytes and in order to create a blob to hold the intent payload we must either coordinate with the XBlob server or do some dance where the XBlob server advertises possible blob ids and we grab one.  In order to send an xintent, we need to 
```C
int win = XAllocId();
XCreateWindow(win);
int payload = await XBlobCreate(win);
int blobHost = await XGetSelectionOwner(payload);
XSetProperty(dpy, blobHost, payload, atoms('STRING'), jsonPayload);
XClientMessage(...{win, payload})
```
note that
* any other protocol to get a blob id will have as many round trips
* XCreateWindow is not a round trip, so theres no point in not creating a window to have an ipc port
* the cooperative security model in XSECURE V0 is going to look at the `_NET_WM_PID` on the window to decide security policy

### Content-Encoding: fd-rights
This is not currently available, it is completely coherent for an http message to include a fd, but nodejs and bun throw away any fd included in an http message.  Client libraries attempt to transparently transform fd-rights into file-path.

# `XINTENT_INTENT_V0` and `XINTENT_EVENT_V0`
These are XChannelJsonFrame's with {intent: fs.PickFile} and {event: fs.PickFileResponse}
* Whoever sends the event that closes the channel MAY send `{disposition: final/error/cancel}` in the payload.
* When sending an intent, a client may send `Prefer: return=minimal` to tell bridges they dont have to pull any data blob's data to the sender's bus and just need to return the blob id to the sender.  The sender can then send that data blob id somewhere else, facilitating minimal network hops for bulk data (e.g. cool-ebooks sending tts intents here and audio data there).

# XBLOB V0
The goal of XBlob is to be anonymous pixmaps for arbitrary data, to be ceph/hadoop for your personal distributed computing environment.  An XBlob is identified by a 32 bit bus local id.

## XBlob Types
An XBlob is a server record like a window, it has a list of properties.  The important ones are

|  Atom      |  Type   |  Description
---
| XBlobType | XA_ATOM |  Blob, File, ReadableStream, MediaStream, Directory
| type      | XA_ATOM |  video/x-msvideo (codecs=mpeg4,xvid,mp3)
| name      | STRING  |  a Blob with a name is a File
| size      | CARD64  |  a ReadableStream gets a size when it becomes a Blob
---
| links     | list    |  X clients with a link
| soft links| list    |  A soft link recieves XBlobDestructor once all the hard links are unlinked
| hosts     | list    |  A list of hosts the blob is available on

* A ReadableStream starts with a pool and continues with a stream until its closed and becomes a Blob.  Concretely, its a a fd that one holder has open for appending appending.
* A MediaStream is a pipe, no pool at the beginning.
* The blob host is responsible for giving the reader who does a GET on a ReadableStream and asks for a fd an fd.  This makes the blob host responsible for turning a pipe it's given as a ReadableStream into a storage-backed fd.  The blob host does an inotify to find out when the producer finishes and closes the stream for writing, at which point the blob host promotes the ReadableStream to a Blob, giving it a size property, and sends XBlobStreamClosed to every process with a link.  For a MediaStram, if the blob host gets a fd instead of a pipe, it will nevertheless only transmit new data through a pipe to other processes.  Even though processes can tell when a pipe closes, the XBlobHost will send a courtesy XBlobStreamClosed.
* All blobs and streams are of course transmissible via http
* If there are two blob hosts on different computers in the same X session connected by an `ssh -X`, they have to route their data though the X bus master blob host.  The X bus master blob host must modify the ssh connection to include a port forward, then do an http connection to the remote blob host, after which they can transmit blobs, after which the blob host on user-server can request a blob from the blob host on user-laptop which can request it from the blob host on user-desktop, because theres no direct tunnel from user-server to user-desktop.

```http
GET /blobs/0x67 XBlob/0.1
Content-Type: audio/wav
Content-Length: 9000
Content-Encoding: base64
Accept-Encoding: identity, base64, fd-rights
```

or for Unix domain socket file descriptor transfers:
```http
PUT /blobs XBlob/0.1
Content-Type: application/octet-stream
Content-Encoding: fd-rights

[attached fd]
```

Response:
```http
XBlob/0.1 201 Created
Content-Type: application/json
Accept-Encoding: identity, base64, fd-rights
Content-Encoding: fd-rights
X-Blob-Id: 0x67


```

a file would also include
```http
Content-Disposition: attachment; filename="sample.wav"
Last-Modified: Fri, 09 Oct 2026 06:13:00 GMT
```

meanwhile, for streams,
```http
Content-Type: multipart/mixed
Transfer-Encoding: chunked
```

this is likely parsed by client libraries to
```js
{xblobType, type, size, name, data, _dataType}
```
* _dataType is probably one of text, json, base64, identity, fd0-rights


While most clients would PUT/GET/POST to their local blob host for creates, reads, writes, to unlink a blob or broadcast an update, clients would send those in to the to the busmaster.


## XBlobCreate
an XMessageFrame with message type `XBlobCreateV0`, `data.l[1]` as the client's cookie, `data.l[2]` as the optional `typeAtom` (e.g. `atoms["audio/wav"]`, `atoms["application/json"]`), and optional `data.l[3]` as `initialHardLinker` window ID. When `initialHardLinker` is provided, `xbus-daemon` registers `data.l[3]` as the initial hard link holder in `links: [...]` and registers `data.l[0]` (`senderWin` / host) in `hosts: [...]`. The client cookie won't be needed by the real XBLOB V1 because that would use the X request sequence number. `xbus-daemon` holds `typeAtom` in `xblobRegistry[blobId]` alongside `links`, `softLinks`, and `hosts`, mirroring how the X server holds property type atoms and pixmap depth/format metadata.

## XBlobCreateResponse
an XMessageFrame with message type `XBlobCreateResponseV0`, `data.l[1]` as the 32-bit blob ID, `data.l[2]` as the client's cookie.

## XBlobGrant
an XMessageFrame with message type `XBlobGrantV0`, `data.l[1]` as the blob ID, and `data.l[2]` as a grantee window.

## XBlobTransfer
an XMessageFrame with message type `XBlobTransferV0`, `data.l[1]` as the blob ID, `data.l[2]` as the old owner window, and `data.l[3]` as the new owner window. Updates ownership links in `xbus-daemon`'s `links` list.

## XBlobSoftLink
an XMessageFrame with message type `XBlobSoftLinkV0`, `data.l[1]` as the blob ID, `data.l[2]` as the window to get a soft link.

## XBlobUnlink
an XMessageFrame with message type `XBlobUnlinkV0` and `data.l[1]` as the blob ID.

## XBlobDestructor
an XMessageFrame with message type `XBlobDestructorV0` and `data.l[1]` as the blob ID. Dispatched by `xbus-daemon` directly to all registered host windows (`hosts`) and soft link observers when `links.length == 0` and `softLinks.length == 0`, informing hosts to free local properties, socket buffers, or mmap regions.

## XBlobSoftUnlink
an XMessageFrame with message type `XBlobSoftUnlinkV0` and `data.l[1]` as the blob ID.  Removes the soft link.

## XBlobAnnounceHost
an XMessageFrame with message type `XBlobAnnounceHostV0`, `data.l[1]` as the blob ID, `data.l[2]` as the `XBLOB_HOST` window ID, and optional `data.l[3]` as `typeAtom`. Registers the host window in `xbus-daemon`'s `hosts` list for that blob and updates `typeAtom`.

## XBlobDropHost
an XMessageFrame with message type `XBlobDropHostV0`, `data.l[1]` as the blob ID, and `data.l[2]` as the `XBLOB_HOST` window ID. Removes the host window from `xbus-daemon`'s `hosts` list for that blob when a host evicts its local cache copy.

## XBlobHost registration
an XBlobHost claims an atom for what numa node its on, as `XBLOB_HOST_${host}`, and programs use XGetSelection() to find their local XBlobHost.  Then `XBlobCreate` returns a 32-bit bus global unique blob ID.  The XBlobHost opens a local socket and advertises its socket path in its `XBLOB_SOCKET_PATH` property on the `XBLOB_HOST` window.  `xbus-daemon` operates strictly as a Control Plane directory, holding `typeAtom`, `links: [...]`, `softLinks: [...]`, and `hosts: [...]` for each blob, without storing payload bytes.

## XBlobBroadcast
an XMessageFrame on the local X bus with message type `XBlobBroadcastV0`, `data.l[1]` as the blob ID, `data.l[2]` as the host id, and `data.l[3]` as the version number. Automatically registers `data.l[2]` in `xbus-daemon`'s `hosts` list and forwards the broadcast to linkers and soft linkers.   Across HTTP bridges, it can also be bridged as an `XJsonFrame` carrying `{hostName, version}`.

## XBlobStreamClosed
an XMessageFrame with message type `XBlobStreamClosedV0`, `data.l[1]` as the blob id, `data.l[2]` as the host id, and `data.l[3]` and `data.l[4]` as its ultimate size.


# XAUDIO aka Pixmaps for Sound
The XAUDIO server probably does something like dump audio into ffmpeg on demand.  It registers itself in its MATCHBOX_TOML as
```toml
[XAudioSink]
name = "my-speakers"
```
thereby registering itself to recieve XAudio commands.  Every XAudio command with a blob attached would require an XBlobGrant of that blob to the XAudioSink, the XAudioSink then unlinks blobs when its done using them.  By default, audio commands on the bus go to the `SESSION_SPEAKERS` holder.
Do Nothing Group has no interest in defining streaming protocols.  Do Nothing Group wants to eat doritos and have hands invalidated for typing and will implement "play this blob in this stream with this seqnum" by drawing letters with the trackball and elbowing the button.
## XAudioPlay
an XChannelJsonFrame with message type `XAudioPlayV0` and payload `{OutputId, volume, loop, streamId, seqnum}` and an attached data blob, which, of course, may be a stream.  Once the XAudioSink has finished playing, it replies with `XAudioPlayResponseV0` with payload `{OutputId, streamId, seqnum, status: 200|500}` if theres a channel open to reply on.
* If `streamId > 0`, the user has opted in to using streams and can queue multiple blobs on a nonzero streamId to be played in seqnum order, but, stream 0 blobs will be played when received as possible, evicting old sounds if necessary.  If the client sends `Connection: keep-alive`, the server doesnt close the channel after sending its last `XAudioPlayResponseV0`.
* If `loop` is specified, the loop continues until an XAudioControlStream or until the channel closes.
## XAudioControlStream
an XChannelJsonFrame with message type `XAudioControlStreamV0` and payload `{command, pragma, streamId}`.  If there is no attached data blob, the user is accessing the user's StreamId's from XAudioPlay, if there is an attached data blob, the user is accessing the stream the blob is attached to.
* Known commands are play, pause, stop.
* Known pragmas are `{underrunPolicy: 'loop' or 'dead', bufferLen: .25s}`.  If the amount buffered exceeds bufferLen, the audio sink MAY drop the oldest audio.
## XAudioPrefetchSoundBlob
an XChannelJsonFrame with message type `XAudioPrefetchSoundBlobV0`, payload `{OutputId}`, and an attached data blob.  XAudioSink's SHOULD download the blob data and be ready to play it.
## SeekStream
When using pipes, seeks have to be done through negotiation with this.

# TOML Properties
## MATCHBOX_TOML
Windows advertise this -> they get ipc calls.
```toml
[intents]
"fs.SendTo" = {type="audio/*"}

[XAudioSink]
name = "sound-player"
```

## SERVICE_MANIFEST_TOML
Service lighters advertise this and get `sys.Launch` intents

## AGGREGATE_TOML
Intent routers advertise this and bridges propagate it.


# Rationale
## Why XINTENT V0 is based on XBLOB V0
* The immediate thing to use is properties: the client sets a property on its window, then sends an XClientMessage with that property atom.  Now the client has to not exit until the intent router replies to its XClientMessage.
* The other logical thing to use is a property on the intent router.  Now we need to atomically claim that property.
* Properties exist as standard file names for windows to exchange named files.  There is a need for an anonymous blob protocol.

## Why the xintent-router doesnt just hand the intent off to the clients
* We want Super-I intent redirection.  That means the channels need to be controlled by the xintent router.
* Maybe in XINTENT V1 a client that only replies to the intent's senderWin of an xintent-router that sets the senderWin to the original requester could do point to point traffic after being routed.  However, the XBLOB V0 blob containing the intent payload needs to be monitored by the xblob server anyway, and if XINTENT V0 wants to do an implicit blob transfer when it sends that XINTENT ClientMessage it needs the xintent router to be the xblob server.

## Why the txId <-> channel id mapping
there are two choices
* natty txId <-> channel id mapping table held by the channel server
* chatty XIntentChannelOpened with txId and channelId as a channel server ack to the txId request
so with the chatty version
* sender can NOT sent sys.Cancel after sec.NuclearLaunch until AFTER recieving XIntentChannelOpened
* client library and client software is becomplicated
* maybe 3 lines of code are saved on the server
* the client now knows the servers channelId for log correlation, but the server MAY send {event: sys.ChannelOpened, channel} anyway
anyway
* the server must recieve a `{reply: true}` in order to know to open a channel either way, a `{intent: ui.Copy, reply: true}` can be replied to with `{event: ui.Paste}` only if the server knows what channels exist.  To route the `{event: ui.Paste}` without active channel objects, either
* * server will still have to issue channels, then keep in memory who is on what channel forever, until the windows on the channel are destroyed
* * the client will have to know the window and txId from the other client and have to track DestroyNotification from the other client.  The client will only know the other client still existed from the beginning, from, the fact that it received a message with `{reply: true}` and then didnt recieve a message with `{disposition: final/error/cancel}` or see the router go down.  However, if the client is told the other client exists and presented this txId, it could watch that window for DestroyNotify and stream `{event: ui.Paste}` to it without any server channels being leaked
* the existence of an active channels table is essential to the intent redirection feature, because the active channels table tells the intent redirector app what channels are active to have their initial intent redirected
* so there is a small window for a complex system by which `{event: ui.Paste}` can be streamed back without an active channels table, but depending on clients watching each other for DestroyNotify and knowing each others window id and txId.  Instead of becomplicating the clients, we use an active channel to designate that the client is listening on the channel.
* however, both sides can be sure of who theyre talking to once they both have the signed senderWin:txId:timestamp:senderPublicKey:recieverPublicKey
* the sender must allocate a cookie or gate requests which is more complicated.  Thereafter, the simplest client library reuses that cookie instead of replacing it with a server cookie

## Why not let the client atomically claim an atom then give that atom to the XBLOB host
* using XInterAtom, it leaks atoms
* using XGetSelectionOwner/XSetSelectionOwner, its an X protocol round trip instead of an XBLOB protocol round trip

## Why your fire-and-forget service has to manually close the channel
* the alterntive was to use http
```json
{
  "xintent": "0.1",
  "uri": "xintent://xintent-router/ui/Copy",
  "headers": {
    "Accept": "none",
    "Content-Type": "text/plain"
  },
  "body": "hello world",
}
```
your fire and forget service still has to send `202 Accepted` and your other service now sends a multipart/mixed sequence of events back.
* the other alternative was to define a service as being capable of replying if it registers itself with a `replies: true` in its matchbox.toml

## Why no flow control
* in theory tcp is about streams, the streams must drain because the entire stream is what must be preserved.  xintent is a datagram protocol and a valid xintent stream consists of a sequence of datagrams.  therefore xintent doesnt need a multi step closing system
* in practice a process closes a pipe when its no longer interested in the contents, so tcp doesnt need a multi round disconnection protocol either, but does need to distinguish between the connection ending after everything has been transmitted and before, because tcp has no intrinsic sync points to define the previous parts as valid, a zip file is line noise without the last few bytes
* however, the tcp stream shutdown procedure is for bursty networks to ask if the sender is done, because the listener might want to continue to listen if the sender isnt done yet
* and the reason xintent doesnt need that when an intent is complete is well defined.  for example a {intent: ui.Copy} is complete when the clipboard is overwritten and there will be no further {event: ui.Paste}
* nor does xintent need an application layer sys.Ping because x11 already has a _NET_WM_PING

## Why all the NAT
user-desktop has the X session and user has user-phone with flammenwerfer and user-watch with flammenspritzer.  User goes in a cave.  Flammenwerfer and flammenspritzer continue to work over bluetooth because 10.x.x.x is a local address.  When user leaves the cave, flammenwerfer syncs to user-desktop.

## XChannel Control Word
In the XClientMessage, the XChannel control word could be split into top 16 for flags and bottom 16 for txId / channelId.  It would be referred to in the documentation as The XChannel Word and no one would know what it does.

# Notes on Atomic X Operations
When this all moves to V1, we can also use one of the unused bytes of the XInternAtom reply, set it to 0x1 by default and 0x2 if the atom was created.  However, for now, two separate XInternAtom requests sent at the same exact time will do an atomic claim.

* XInternAtom(false)
* XInternAtom(true)
* XGetProperty
* XSetProperty
* XGetSelectionOwner
* XSetSelectionOwner
* XSelectionClear 

