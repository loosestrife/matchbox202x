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
| data.l[1]   : Atom where the reciever can find the json payload       |
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

# XBLOB V0
an XBlob V0 is an X property on the blob server window, to be deleted when its out of links.  The atom for the property is given by the xblob server on XBlobCreate.  The atom is some kind of `XBLOB_BLOB_SLOT_${number}` and these are aggressively reused after unlinking to not leak atoms
```js
{xblobType, mimeType, size, name, data, _dataType}
```
* _dataType is one of text, json, base64
* xblobType is one of File, Blob, ReadableStream, MediaStream
if xblobType is a *Stream, _dataType is json and data is a pseudo-rtmp packet
```js
{type, timestamp, streamId, seqNum, blob: {type, data}}
```
since it is a pseudo-rtmp packet, there is no reason for the data field to not be base64 encoded binary data.

When the xblobType is a *Stream, more than one chunk can be active at a time.  therefore, the blob atom name should be extended to `XBLOB_BLOB_${blobName}_CHUNK_${ChunNum}` for hopefully a small number of ChunkNum's.  the ChunkNum's must not be overwritten until every consumer replies with a `XBlobStreamChunkRecieved`.

## XBlobCreate
an XIntentNonJsonFrame with message type `XBlobCreateV0`.

## XBlobCreateResponse
an XIntentNonJsonFrame with message type `XBlobCreateResponseV0` and `data.l[1]` as he blob atom.

## XBlobGrant
an XIntentNonJsonFrame with message type `XBlobGrantV0`, `data.l[1]` as the blob atom, and `data.l[2]` as a grantee window.

## XBlobUnlink
an XIntentNonJsonFrame with message type `XBlobUnlinkV0` and `data.l[1]` as the blob atom.

## XAudioNodeRegister
an XIntentJsonFrame with message type `XAudioNodeRegister` and payload `{host}`.  This doesn't actually do anything yet, of course.

## XBlobStreamChunkAdvise
an XIntentNonJsonFrame with message type `XBlobStreamChunkAdviseV0` and `data.l[1]` as the main blob atom and `data.l[2]` as the chunk atom.  This is forwarded to every consumer.

## XBlobStreamChunkRecieved
an XIntentNonJsonFrame with message type `XBlobStreamChunkRecievedV0` and `data.l[1]` as the main blob atom and `data.l[2]` as the chunk atom.  This is forwarded to the producer.

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

# Notes on Atomic X Operations
When this all moves to V1, we can also use one of the unused bytes of the XInternAtom reply, set it to 0x1 by default and 0x2 if the atom was created.  However, for now, two separate XInternAtom requests sent at the same exact time will do an atomic claim.

* XInternAtom(false)
* XInternAtom(true)
* XGetProperty
* XSetProperty
* XGetSelectionOwner
* XSetSelectionOwner
* XSelectionClear 

