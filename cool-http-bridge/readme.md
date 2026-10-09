# Cool Http Bridge
* This should know as little as possible about the intents and XAudioPlay's that cross it.
* To make XAudio work at the http-bridge, there is a strict rule: 1 XChannel = 1 WebSocket connection (`/xaudio?XAudioSink=...`) OR 1 HTTP response stream (`/intent/:namespace/:action`).
* All active XChannels across WebSockets and HTTP response streams are tracked centrally in `serverGlobals.channelNatTable` (and in the future, blobs via `serverGlobals.blobNatTable`), inspectable via `GET /api/debug/xaudio`.
* An XAudioPlay command on a socket or HTTP stream addressed to an XAudioSink (e.g. `user-desktop-speakers` or `flammenwerfer-phone`) maps to an active XChannel session in `serverGlobals.channelNatTable`.
* An XAudio packet with control word FIN drops/completes the XChannel.
* If a WebSocket drops while an XChannel is active, the other side of the XChannel gets a `{event: "http.502", message: "Connection reset by peer.", controlWord: 2}` with control word FIN.
