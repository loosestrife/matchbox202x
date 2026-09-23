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
an XBlob V0 is an X property on the blob server window, to be deleted when its out of links.  While XBLOB V1 will get blob id's from the server directly, the client that creates a XBLOB V0 gets to choose an atom for it, and should choose a string starting with `XBLOB_BLOB_` then atomically claiming it with an XInternAtom(true) followed by an XInternAtom(false).  This atom is then used to set the property on the blob server window, inside the property goes the canonical json
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

The xblob server becomes aware of an XBlob V0 when it recieves an XBlobCreate.  It will thereafter be able to delete the XBlob when everything with a reference to it has unlinked it or exited.

When the xblobType is a *Stream, more than one chunk can be active at a time.  therefore, the blob atom name should be extended to `XBLOB_BLOB_${blobName}_CHUNK_${ChunNum}` for hopefully a small number of ChunkNum's.  the ChunkNum's must not be overwritten until every consumer replies with a `XBlobStreamChunkRecieved`.

## XBlobCreate
an XIntentNonJsonFrame with message type `XBlobCreateV0` and `data.l[1]` as the blob atom.

## XBlobGrant
an XIntentNonJsonFrame with message type `XBlobGrantV0`, `data.l[1]` as the blob atom, and `data.l[2]` as a grantee window.

## XBlobUnlink
an XIntentNonJsonFrame with message type `XBlobUnlinkV0` and `data.l[1]` as the blob atom.

## XAudioNodeRegister
an XIntentJsonFrame with message type `XAudioNodeRegister` and payload `{host}`.  This doesn't actually do anything, of course.

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

# Notes on Atomic X Operations
When this all moves to V1, we can also use one of the unused bytes of the XInternAtom reply, set it to 0x1 by default and 0x2 if the atom was created.  However, for now, two separate XInternAtom requests sent at the same exact time will do an atomic claim.

* XInternAtom(false)
* XInternAtom(true)
* XGetProperty
* XSetProperty
* XGetSelectionOwner
* XSetSelectionOwner
* XSelectionClear 

