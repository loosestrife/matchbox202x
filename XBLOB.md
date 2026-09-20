# XBLOB V0 and XAUDIO V0
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
an XBlob V0 is an X property on the intent router window, to be deleted when its out of links.  The client that creates a XBLOB V0 gets to choose an atom for it instead of the X server choosing a 32 bit number for the blob id, then, writing out ``XBLOB_BLOB_0X${BlobId.toString(16).toUpperCase()}``, then claiming that as an atom name to verify uniqueness.  This atom is then used to set the property on the intent router window, inside the property goes the canonical json
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

The xintent router becomes aware of an XBlob V0 when it recieves an XBlobCreate.  It will thereafter be able to delete the XBlob when everything with a reference to it has unlinked it or exited.

When the xblobType is a *Stream, more than one chunk can be active at a time.  therefore, the blob atom gets extended to ``XBLOB_BLOB_0x${BlobId}_${ChunkNum}`` for hopefully a small number of ChunkNum's.  the ChunkNum's must not be overwritten until every consumer replies with a `XBlobStreamChunkRecieved`.

## XBlobCreate
an XIntentNonJsonFrame with message type `XBlobCreateV0` and `data.l[1]` as the blob id number.  The blob id atom is derived from the blob id number.

## XBlobGrant
an XIntentNonJsonFrame with message type `XBlobGrantV0`, `data.l[1]` as the blob id number, and `data.l[2]` as the grantee id number

## XBlobUnlink
an XIntentNonJsonFrame with message type `XBlobUnlinkV0` and `data.l[1]` as the blob id number.

## XAudioNodeRegister
an XIntentJsonFrame with message type `XAudioNodeRegister` and payload `{host}`.  This doesn't actually do anything, of course.

## XBlobStreamChunkAdvise
an XIntentNonJsonFrame with message type `XBlobStreamChunkAdviseV0` and `data.l[1]` as the blob id number and `data.l[2]` as stream chunk number.  This is forwarded to every consumer.

## XBlobStreamChunkRecieved
an XIntentNonJsonFrame with message type `XBlobStreamChunkRecievedV0` and `data.l[1]` as the blob id number and `data.l[2]` as the stream chunk number.  This is forwarded to the producer.

# XAUDIO V0
The XINTENT router will of course take responsibility for dumping audio into ffmpeg on demand.
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