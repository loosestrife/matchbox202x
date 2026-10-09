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
* any other protocol to get a blob atom will have as many round trips
* XCreateWindow is not a round trip, so theres no point in not creating a window to have an ipc port
* the cooperative security model in XSECURE V0 is going to look at the `_NET_WM_PID` on the window to decide security policy

### XBlob V0 and `xprop`
`xprop` tries to dump property data into the terminal and that cant be done on the XBlobHost windows because theyre full of huge binary data.

# `XINTENT_INTENT_V0` and `XINTENT_EVENT_V0`
These are XChannelJsonFrame's with {intent: fs.PickFile} and {event: fs.PickFileResponse}
* Whoever sends the event that closes the channel MAY send `{disposition: final/error/cancel}` in the payload.
* When sending an intent, a client may send `Prefer: return=minimal` to tell bridges they dont have to pull any data blob's data to the sender's bus and just need to return the blob id to the sender.  The sender can then send that data blob id somewhere else, facilitating minimal network hops for bulk data (e.g. cool-ebooks sending tts intents here and audio data there).

# XBLOB V0
an XBlob V0 is an X property on the blob host window, to be deleted when its out of links.  XBlob V1 id's will not be atoms, but they will be nonzero u32 values.  The atom for the property is given by the xblob server on XBlobCreate.  The atom is some kind of `XBLOB_BLOB_SLOT_${number}` and these are aggressively reused after unlinking to not leak atoms
```http
Content-Type: audio/wav
Content-Length: 9000
Content-Encoding: base64
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
Expect: 100-continue
X-Stream-Chunk: 0
X-Stream-Credit: 0
```

this is likely parsed by client libraries to
```js
{xblobType, type, size, name, data, _dataType}
```
* _dataType is one of text, json, base64
* xblobType is one of File, Blob, ReadableStream, Directory, MediaStream
* if type is multipart/mixed, and _dataType is json, the representation would be as an array of xblobs
* if xblobType is a MediaStream, _dataType is json and data is a pseudo-rtmp packet
```js
{type, timestamp, streamId, seqNum, blob: {type, data}}
```
since it is a pseudo-rtmp packet, there is no reason for the data field to not be base64 encoded binary data.

When the xblobType is a *Stream, more than one chunk can be active at a time.  therefore, the blob atom name should be extended to `XBLOB_BLOB_${blobName}_CHUNK_${ChunNum}` for hopefully a small number of ChunkNum's.  the ChunkNum's must not be overwritten until every consumer replies with a `XBlobStreamChunkReceived`, but should be reused as soon as possible.

XBlob requests are always bus local since XBlob id's are bus local.  When an XBlob is linked across a bridge, both sides of the bridge need XBlob id's for it, the bridge would hold links on both sides and the nat table, and if the bridge dies, the links are automatically unlinked at the same time as the dead bridge loses the nat table.  The XBlobBroadcast is also bus local, but it is propagated across bridges accordingly as there are links.

## XBlobCreate
an XMessageFrame with message type `XBlobCreateV0` and `data.l[1]` as the client's cookie.  The client cookie won't be needed by the real XBLOB V1 because that would use the X request seqence number.

## XBlobCreateResponse
an XMessageFrame with message type `XBlobCreateResponseV0`, `data.l[1]` as the blob atom, `data.l[2]` as the client's cookie.

## XBlobGrant
an XMessageFrame with message type `XBlobGrantV0`, `data.l[1]` as the blob atom, and `data.l[2]` as a grantee window.

## XBlobSoftLink
an XMessageFrame with message type `XBlobSoftLinkV0`, `data.l[1]` as the blob atom, `data.l[2]` as the window to get a soft link.

## XBlobUnlink
an XMessageFrame with message type `XBlobUnlinkV0` and `data.l[1]` as the blob atom.

## XBlobDestructor
an XMessageFrame with message type `XBlobDestructorV0` and `data.l[1]` as the blob atom.  Informs soft linkers that the blob has reached refcount 0.

## XBlobSoftUnlink
an XMessageFrame with message type `XBlobSoftUnlinkV0` and `data.l[1]` as the blob atom.  Removes the soft link.

## XBlobStreamChunkAdvise
an XMessageFrame with message type `XBlobStreamChunkAdviseV0` and `data.l[1]` as the main blob atom and `data.l[2]` as the chunk atom.  This is forwarded to every consumer.

## XBlobStreamChunkReceived
an XMessageFrame with message type `XBlobStreamChunkReceivedV0` and `data.l[1]` as the main blob atom and `data.l[2]` as the chunk atom.  This is forwarded to the producer.

## XBlobHost registration
an XBlobHost claims an atom for what numa node its on, as `XBLOB_HOST_${host}`, and progams use XGetSelection() to find their local XBlobHost.  Then `XBlobCreate` returns a bus global unique atom, but the XBLOB is actually on the window that owns the atom according to XGetSelection().

## XBlobBroadcast
an XMessageFrame with message type `XBlobBroadcastV0`, `data.l[1]` as the blob id, `data.l[2]` as the host atom, `data.l[3]` as the version.  Broadcasts local modification to other numa nodes, linkers, soft linkers, so they can read the new contents if they want.  By the way the host atom is bus unique and must be natted, which, of course, everyone already knows.

# XAUDIO V0
The XAUDIO server probably does something like dump audio into ffmpeg on demand.  It registers itself in its MATCHBOX_TOML as
```toml
[XAudioSink]
name = "my-speakers"
```
thereby registering itself to recieve XAudio commands.  Every XAudio command with a blob attached would require an XBlobGrant of that blob to the XAudioSink, the XAudioSink then unlinks blobs when its done using them.
## XAudioPlay
an XChannelJsonFrame with message type `XAudioPlayV0` and payload `{OutputId, volume, loop, streamId, seqnum}` and an attached data blob.  Once the XAudioSink has finished playing, it replies with `XAudioPlayResponseV0` with payload `{streamId, seqnum, status: 200|500}` if theres a channel open to reply on.  If `streamId > 0`, the user has opted in to using streams and can queue multiple blobs on a nonzero streamId to be played in seqnum order, but, stream 0 blobs will be played when received as possible, evicting old sounds if necessary.  If `loop` is specified, the client that sent the XAudioPlay will have to cancel the loop at some point with an `XAudioControlStream({command: stop, streamId})`, or, when the channel closes.
## XAudioPrefetchSoundBlob
an XChannelJsonFrame with message type `XAudioPrefetchSoundBlobV0`, payload `{OutputId}`, and an attached data blob.  XAudioSink's SHOULD download the blob data and be ready to play it.
## ControlStream
an XChannelJsonFrame with message type `XAudioControlStreamV0` and payload `{command, streamId}`.  If there is no attached data blob, the user is accessing the user's StreamId's from XAudioPlay, if there is an attached data blob, the user is accessing the StreamId's from the BlobId MediaStream.
## SeekStream
an XChannelJsonFrame with message type `XAudioSeekStreamV0`, payload `{streamId, seekTo}`, and an attached data blob.

# TOML Properties
## MATCHBOX_TOML
Windows advertise this -> they get ipc calls.
```toml
[intents]
"fs.SaveAs" = {type="audio/*"}

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

