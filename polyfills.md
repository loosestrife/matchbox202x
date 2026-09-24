# V0
It takes 0 intelligence to "invent" stuff that everyone already knows exactly how it works and should have existed already.  The hard part is the V0 polyfills, full of insecurity and questionable decisions.

## XIntentJsonFrame
an XIntentJsonFrame is a special XClientMessage
```
|                       XClientMessageEvent                             |
+-----------------------------------------------------------------------+
| type        : ClientMessage                                           |
| window      : Target Window XID                                       |
| message_type: Atom("MESSAGE_TYPE_ATOM")                               |
| format      : 32                                                      |
| data.l[0]   : Sender Window XID                                       |
| data.l[1]   : Payload XBLOB atom                                      |
```

## XIntentNonJsonFrame
an XIntentNonJsonFrame is a special XClientMessage
```
|                       XClientMessageEvent                             |
+-----------------------------------------------------------------------+
| type        : ClientMessage                                           |
| window      : Target Window XID                                       |
| message_type: Atom("MESSAGE_TYPE_ATOM")                               |
| format      : 32                                                      |
| data.l[0]   : Sender Window XID                                       |
```

## Limitations
It is not possible to send an xintent without registering a window, even for fire and forget intents like `ui.Copy`.  This is because XClientMessage is 20 bytes and in order to create a blob to hold the intent payload we must either coordinate with the XBlob server or do some dance where the XBlob server advertises possible blob atoms and we grab one.  In order to send an xintent, we need to 
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
* the blobHost round trip is gratuitous in XINTENT V0 
* XCreateWindow is not a round trip, so theres no point in not creating a window to have an ipc port
* the cooperative security model in XSECURE V0 is going to look at the `_NET_WM_PID` on the window to decide security policy

# `XINTENT_INTENT_V0` and `XINTENT_EVENT_V0`
XIntentJsonFrame with `data[2]=txId` to the sender and `data[2]=channelId` to everyone else.  The sender's txId has to be under 16777216 and the server promises to only use numbers 16777216 and up to designate channels.  That way the client's txId will never collide with a server channel number.  Data blob atom on `data[3]`.

# XBLOB V0
an XBlob V0 is an X property on the blob host window, to be deleted when its out of links.  The atom for the property is given by the xblob server on XBlobCreate.  The atom is some kind of `XBLOB_BLOB_SLOT_${number}` and these are aggressively reused after unlinking to not leak atoms
```js
{xblobType, type, size, name, data, _dataType}
```
* _dataType is one of text, json, base64
* xblobType is one of File, Blob, ReadableStream, MediaStream
if xblobType is a *Stream, _dataType is json and data is a pseudo-rtmp packet
```js
{type, timestamp, streamId, seqNum, blob: {type, data}}
```
since it is a pseudo-rtmp packet, there is no reason for the data field to not be base64 encoded binary data.

When the xblobType is a *Stream, more than one chunk can be active at a time.  therefore, the blob atom name should be extended to `XBLOB_BLOB_${blobName}_CHUNK_${ChunNum}` for hopefully a small number of ChunkNum's.  the ChunkNum's must not be overwritten until every consumer replies with a `XBlobStreamChunkRecieved`, but should be reused as soon as possible.

## XBlobCreate
an XIntentNonJsonFrame with message type `XBlobCreateV0` and `data.l[1]` as the client's cookie.  The client cookie won't be needed by the real XBLOB V1 because that would use the seqence number.

## XBlobCreateResponse
an XIntentNonJsonFrame with message type `XBlobCreateResponseV0`, `data.l[1]` as the blob atom, `data.l[2]` as the client's cookie.

## XBlobGrant
an XIntentNonJsonFrame with message type `XBlobGrantV0`, `data.l[1]` as the blob atom, and `data.l[2]` as a grantee window.

## XBlobUnlink
an XIntentNonJsonFrame with message type `XBlobUnlinkV0` and `data.l[1]` as the blob atom.

## XBlobStreamChunkAdvise
an XIntentNonJsonFrame with message type `XBlobStreamChunkAdviseV0` and `data.l[1]` as the main blob atom and `data.l[2]` as the chunk atom.  This is forwarded to every consumer.

## XBlobStreamChunkRecieved
an XIntentNonJsonFrame with message type `XBlobStreamChunkRecievedV0` and `data.l[1]` as the main blob atom and `data.l[2]` as the chunk atom.  This is forwarded to the producer.

## XAudioNode registation
an XAudioNode claims an atom for what numa node its on, as `XAUDIO_NODE_${host}`, and progams use XGetSelection() to find their local XAudioNode.  Then `XBlobCreate` returns a globally unique atom, but the XBLOB is actually on the window that owns the atom according to XGetSelection().

## XAudioNodeMoveBlob
an XIntentNonJsonFrame with message type `XAudioNodeMoveBlobV0`, `data.l[1]` as the blob atom, `data.l[2]` as the XAudioNode window to move the blob to.

# XAUDIO V0
The XAUDIO server probably does something like dump audio into ffmpeg on demand.
## XAudioPlaySoundBlob
an XIntentJsonFrame with message type `XAudioPlaySoundBlobV0` and payload `{BlobId, OutputId, volume, loop}`
## XAudioPrefetchSoundBlob
an XIntentJsonFrame with message type `XAudioPrefetchSoundBlobV0` and payload `{BlobId, OutputId}`.  It does nothing.
## XAudioGetAudioOutputs 
this one is an `XIntentIntentV0` and it gets a reply with a `{outputs: [{type: speakers, name: the computers sound output}]}`
## PlayStream
an XIntentJsonFrame with message type `XAudioPlayStreamV0` and payload `{BlobId, OutputId, volume}`
## ControlStream
an XIntentJsonFrame with message type `XAudioControlStreamV0` and payload `{command, ...}`
## SeekStream
an XIntentJsonFrame with message type `XAudioSeekStreamV0` and payload `{seekTo}`

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
* * the client will have to know the window and txId from the other client and have to track DestroyNotification from the other client.  The client will only know the other client still existed from the beginning, from, the fact that it recieved a message with `{reply: true}` and then didnt recieve a message with `{disposition: final/error/cancel}` or see the router go down.  However, if the client is told the other client exists and presented this txId, it could watch that window for DestroyNotify and stream `{event: ui.Paste}` to it without any server channels being leaked
* the existence of an active channels table is essential to the intent redirection feature, because the active channels table tells the intent redirector app what channels are active to have their initial intent redirected
* so there is a small window for a complex system by which `{event: ui.Paste}` can be streamed back without an active channels table, but depending on clients watching each other for DestroyNotify and knowing each others window id and txId.  Instead of becomplicating the clients, we use an active channel to designate that the client is listening on the channel.
* however, both sides can be sure of who theyre talking to once they both have the signed senderWin:txId:timestamp:senderPublicKey:recieverPublicKey

## Why not let the client atomically claim an atom then give that atom to the XBLOB host
* using XInterAtom, it leaks atoms
* using XGetSelectionOwner/XSetSelectionOwner, its an X protocol round trip instead of an XBLOB protocol round trip

# Notes on Atomic X Operations
When this all moves to V1, we can also use one of the unused bytes of the XInternAtom reply, set it to 0x1 by default and 0x2 if the atom was created.  However, for now, two separate XInternAtom requests sent at the same exact time will do an atomic claim.

* XInternAtom(false)
* XInternAtom(true)
* XGetProperty
* XSetProperty
* XGetSelectionOwner
* XSetSelectionOwner
* XSelectionClear 

