# UNIX Desktop & Application Platform Specification
**Version 0.1.0-DRAFT**  
**Status:** Proposal / Reference Specification

---

## High-Level Architectural Description

### Executive Overview
The modern UNIX desktop ecosystem suffers from severe fragmentation, redundant abstractions, and excessive resource overhead. Over the past two decades, traditional system interfaces have been systematically obscured by multi-layered IPC daemons (`dbus-daemon`), custom compositors, sandboxing runtimes (Flatpak, Snap), language-isolated package manifests (`package.json`, `Cargo.toml`, `pyproject.toml`), and heavy web-runtime wrappers.

This specification defines a unified, lightweight desktop platform constructed entirely from proven, off-the-shelf POSIX and X11 primitives. It proves that a fully capable, sandboxed, intent-driven, mobile/tablet-friendly operating system requires zero custom IPC protocols, no dedicated system bus daemons, and no bespoke package management infrastructure.

### 0 Core Design Philosophy
1. **Zero Invention Design** everything has already been invented
2. **Back to the 90's** `ssh -X` into the solaris server and fire applescript events like its the 90's
3. **Single Control Multiple Data** one bus many clients, one control stream many data streams
4. **Universal IPC Surface** paper over command invocation, stdin/stdout, rest, dlsym
5. **Inspectable TOML Configurations** the admin has to be able to understand whats going on

# 0.1 Back In My Day
* **Endpoints ride the environment.** The app doesnt think about the session it reads $DISPLAY. Zero configuration.
* **Credentials ride the same channel they protect.** sshd wrote a fake cookie and set XAUTHORITY; the secret and the address arrived together.
* **One forwarded channel per machine-pair**, everything multiplexed. Ten windows, one connection.  Single control channel.
* **Membership is the connection.** Client dies → socket closes → server notices → gone. No unregister protocol, no keepalives, no ghosts.

# 0.2 The 90's Future
* sound follows your ssh -X connection
* multimedia over ssh -X automatically uses secondary data streams
* java-based apps can freeze on one device and thaw on another device
* the 90's future did not include `curl | bash` it included `apt install package`, perhaps, after `apt-add-repository`.  the 90's future would have been ok with `curl > ~/.packages/app.toml` followed by `app-manager sync` where app-manager would expressly ask for permission to do anything more than install deps from trusted sources and run the app with some sandboxing

---

## 1. System Architecture & Bus Routing
### 1.1 Components
* XAUDIO: add speakers and mics to your session the way you wanted in the 90's
* matchbox202x: tablet window manager
* compiz202x: laptop window manager
* Toml Package System: tps formalizes the rich command surface of intents and events, specifying how intents are written as json, command line parameters, c structures, rest commands, so that scripts can send and recieve intents over a socket or over stdin/stdout in NNJSON format, .so modules can have their index.toml embedded in the elf so the module host program can dlsym the right function and run it from a single vtable, external servers can send and recieve intents and stream events over http
* XINTENT: intent routing through the x session, because the x session has since the 70's been the highest performance desktop bus 
* XSECURE: coping with your ex-secure system that you connected to the network. Multiplexes connection types, unix socket from user, tcp socket from network and ip, policykit jwt, with actions to authorize, intents to fire, events to receive, clipboards and window contexts, permission to open a window without decorations or fullscreen. XSecure.toml to be readable by the admin 

### 1.2 User's Distributed Lifestyle
User is running a session on user-phone and has an ssh -X to user-laptop in the coffee shop with him and an ssh -X to user-desktop at home over tailscale.  User is running cool-ebook off user-laptop where the files are but cool-ebook's html card is running on user-phone.
* Naively, tts intents stream locally from user-laptop:cool-ebook's html card to user-phone:cool-tts, burning user-phone's battery and lagging becaue cool-tts is slower on user-phone than on user-laptop.
* User needs to run `platform-services-session` in its .profile when it logs in to user-laptop over ssh -X in order for the session server to know what services user-laptop provides.  Non local services get a little connect icon and are labeled `user-desktop:cool-tts` for the purpose of `libserver intent --intent ui.TextToSpeech --text "my string" --app user-desktop:cool-tts`
* `platform-services-session` launches a headless x client daemon to load services in response to requests from matchbox202x-desktop-panel

### 1.3 Web First
```
POST http://localhost:12345/intent/ui/TextToSpeech?app=user-desktop:cool-tts
{
  "text": "In the beginning God created the heavens and the earth.  And the earth was formless and void, and",
  "format": "audio/wav",
  "voice": "torbjorn",
  "speed": 1.5,
  "params": {
    "tts": "qwen-tts"
  }
}

HTTP 200 OK
Libplatform-Bridge: 1.0
Content-Type: multipart/mixed
Content-Type: application/json
Content-Disposition: inline
{
  "intent": "ui.TextToSpeechProcessing",
  "format": "audio/wav",
  "timeLeft": 2.3,
  "percent", 23.4567
}

Content-Type: application/json
Content-Disposition: inline
{
  "intent": "ui.TextToSpeechResponse"
  "disposition": "final"
}

Content-Type: audio/wav
Content-Disposition: attachment; filename="speech.wav"
```

### 1.4 Session and System Buses (`DISPLAY=:0` and `DISPLAY=:99`)
* this is an already existing universal ipc framework
* X messages are the fastest way to communicate and libraries exist everywhere
* X needed a plugged in web browser for html windows in the 90's though there were attempts at ps and pdf which failed because those are less human readable than a pixmap, display pdf is the same draw commands as display xrender and display quckdraw.  in the late 90's and early 00's there were multiple attempts at XUL, XAML, gtk's xml format, and only html survived, as well as android's siloed xml format for android sharecroppers


### 1.5 Lifecycle Management
* in the 90's, there was X Session Management Protocol and XScreenSaver, these need to be extended to allow matchbox202x to kill processes whose cards havent been on screen or havent responded to any intents in a while, while compiz202x leaves everything open forever

### 1.6 Write Your app.toml Today to Access Your App through Intents
* put `app.toml` in `/user/local/matchbox/` alongside all the other apps.  `matchbox202x sync` will do the `uv sync` thing of ensuring that every app is ready to go with a `matchbox202x intent --app localhost:app --intent appIntent --data "my data"`
* just like in the 1990's with applescript events

---

## 2. Application Package Format (`index.toml`)

Applications are distributed as compressed `.zip` archives (or single ELF binaries with an embedded `.index_toml` segment).

my-app.zip
├── index.toml          # Package manifest & IPC contracts
├── bin/
│   └── app_binary      # Compiled entrypoint (optional)
├── cards/
│   ├── index.html      # Primary UI card
│   └── settings.html   # Secondary UI card
└── assets/
└── favicon.ico         # Launcher icon

Applications not installed in libserver are simply `my-cool-app.toml` files.  These refer intents and events to other processes.

### 2.1 Canonical `index.toml` Schema

```toml
#!/usr/bin/matchbox202x
[package]
id = "org.unix.editor"
version = "1.0.0"
name = "Simple Text Editor"
description = "POSIX-compliant web-card text editor"
favicon_ico = ":pencil:"

[dependencies]
"nix:python3" = "3.14"
"python:torch" = "2.13"
"sys:firefox" = "128 (compatible; chromium 365)" # my cards need css7

[permissions]
network = false
filesystem = ["~/Documents"]

[build]
exec = "uv sync"
execDir = "."
args = []
env = {}

[app]
type = "html"
card = "main"

[[cards]]
id = "main"
path = "cards/index.html"
title = "Editor Main"

[[cards]]
id = "settings"
path = "cards/settings.html"
title = "Preferences"

# Intent Receivers (External Command Surface)
[intents."ui.TextProcess"]
invocation = "pipe"
exec = "bin/text_processor"
args = "--intent-server"

[intents."file.Open"]
invocation = "card"
card = "main"

[events]
"sys.DisplayRotated" = { invocation = "command", exec = "bin/app_binary", args = ["process-event"] }
"net.StateChanged"   = { invocation = "card", card = "settings" }

# lets try and merge these apps with system services
[service]
# Maps directly to systemd [Service] directives
exec = "bin/emacsd"
type = "simple"
restart = "on-failure"
restart_sec = "2s"
nice = -5

# Sandboxing & Security (mapped to systemd isolation flags)
protect_system = "strict"
protect_home = "read-only"
private_tmp = true
memory_max = "2G"

[service.targets]
# Systemd target bindings
wanted_by = ["default.target"]
after = ["network.target", "sound.target"]
```

---

# 5. Canonical Data Models
### 5.1 JSON Intent/Event Schema

However processes recieve intents/events, the canonical json and conceptual structure is
```JSON
{
  "intent": "ui.TextProcess", 
  "text": "how do i restore unix",
  "replace": true,
  "reply": true
}
```
which gets responded to with
```JSON
{
  "event": "ui.Processing",
  "percent": 67,
  "channel": "aX4f"
}

{
  "intent": "ui.TextProcessReply",
  "text": "How do I restore UNIX®?",
  "channel": "aX4f",
  "disposition": "final"
}
```
Any RPC server has to handle the process boundary between processes and have a client library to handle routing inside the processes.  In X, the channel is given first by the target window, then by the sender window and transaction id fields of the client message.  Outside of X, the server allocate Channel's
```JavaScript
channels = {'aX4f': {sender, reciever, initialIntent}}
```
so the client would
```Javascript
channel = await intensive.fire({intent, reply: true})
```
and the server would reply with a channel because the client asked for a reply, and attach the channel to the json message for the recieving client, the sending client or recieving client can then close the channel at any time with a message with `{disposition: "cancel"}` or `{disposition: final}`.  Besides being the honest thing to do, the server replying with a channel ack is just another layer of ack on top of the tcp ack and doesnt add latency to the intent response.  If a client tries to send more than 100 intents with `{reply: true}` and get more than 100 channels allocated at a time, it can get an `EMFILE` back.  If a client disconnects, the server sends `{event: "ECONNRESET", msg: "Connection reset by peer", disposition: "error"}`, so, the dispositions are final, cancel, and error.'

None of this was invented here.  The protocal name is NIH-RPC.

## 3. Intent & Event Wire Protocol (X11 Primitives)

Intents (requesting an action) and Events (broadcasting a state change) are transmitted across the X11 server using native `ClientMessage` structures and X Properties.

### 3.1 Overview
The intent router registers the atom `XINTENT` to assert that there is an `XINTENT` implementation on the X server and then sets the `XINTENT` property of the root window as a window with name `"INTENT_ROUTER"`.

It then listens for `ClientMessage`'s with message type atom `XINTENT_INTENT_V0`, the first three data fields are senderWin, targetPropAtom, and txId.  It gets the canonical JSON payload from its property targetPropAtom, then deletes that property.

If there is a blob associated with the intent, it is specified in `payload.blob` to be on the intent router window at property `payload.blob.blobPropAtom`.

### 3.1 Canonical Data Models
An Intent or Event is sent via `XSendEvent` as an `XClientMessageEvent` formatted with `format = 32`:

+-----------------------------------------------------------------------+
|                       XClientMessageEvent                             |
+-----------------------------------------------------------------------+
| type        : ClientMessage                                           |
| window      : Target Window XID                                       |
| message_type: Atom("XINTENT_INTENT_V0")                               |
| format      : 32                                                      |
| data.l[0]   : Sender Window XID                                       |
| data.l[1]   : Atom where the reciever can find the payload            |
| data.l[2]   : Transaction id                                          |
| data.l[3]   : unused                                                  |
| data.l[4]   : unused                                                  |
+-----------------------------------------------------------------------+

---
# 4. UI Rendering, Web Cards, & Window Management
### 4.1 Tablet Card-Deck Window Manager
Top-level windows are "Cards".  If an app has good "Cards", it can run on a phone.

### 4.2 Web Rendering & XSettings
Programs may generate UI by providing HTML/CSS markup to a system-wide Web Browser process using XEmbed socket frames.

Inter-Card Communication: HTML Cards within the same app session communicate state using standard web BroadcastChannel APIs.  Otherwise, they only communicate by sending intents from their buttons back to their app, exactly as if they were ordinary X windows and the app would recieve X events exactly the same way.

System Styling: The shared Web Browser reads the system themes, DPI, and scaling directly from the _XSETTINGS_SETTINGS root window property.

### 5.2 C API Struct (libplatform.h)

For trusted ELF objects linked directly against libplatform:
```C

typedef struct {
    uint32_t type;            /* 1 = Intent, 2 = Event */
    const char *action;       /* Atom string, e.g., "ui.TextProcess" */
    uint32_t sender_xid;      /* Sender Window ID */
    uint64_t timestamp;       /* Unix Epoch timestamp */
    const char *json_payload; /* Null-terminated JSON string */
} platform_message_t;

typedef void (*platform_handler_t)(const platform_message_t *msg);

/* API Functions */
int platform_register_intent(const char *action, platform_handler_t handler);
int platform_emit_event(const char *action, const char *json_payload);
int platform_send_intent(const char *target_app_id, const char *action, const char *json_payload);
```

# 6. Binary ELF Integration (.index_toml Segment)

High-performance applications written in C/C++/Rust may avoid shipping a .zip file by embedding their index.toml directly inside the binary object file.

    Section Name: .index_toml

    Format: Uncompressed UTF-8 string containing valid TOML text.

    Detection: The platform app launcher scans .so's linked in its apps/ directory for the .index_toml segment and registers their intents

```Bash
objcopy --add-section .index_toml=index.toml \
        --set-section-flags .index_toml=readonly,data \
        my_binary my_app
```

# 7. libplatform CLI & Multiplexer Specification

libplatform unifies process execution, argument parsing, and X11 wire dispatch into a single tool interface.
### 7.1 Command Line Surface
```Bash

# Invoking an intent directly (auto-dispatches to registered handler)
libplatform --intent ui.TextProcess --data '{"text":"Hello World"}'
myapp --intent ui.TextProcess --text "Hello World"
libplatform --app user-desktop:org.unix.editor --intent file.Open --path "/home/user/doc.txt"

```

### 7.2 CLI Argument Translation Rules

* libplatform maps cli arguments into the intent json according to the intent json schema
* LIBPLATFORM_RUN_ON=user-server applies --app user-server: unless --app localhost: is already specified
* DISPLAY=:0 libserver query servers provides the list of possible LIBSERVER_RUN_ON whereas DISPLAY=:99 libserver query server might list that some other server provides some system service


# 8. Disintermediating the Intent Server for Media Streams
When an application generates large payloads or streams, instead of those going through X, they need to be sent through shm/sockets or files/scp.

### 8.1 File Ownership Transfer Protocol (sys.TransferFile)
[ App A: cool-ebook ]         [ System Mediator: NIHRPCXD ]     [ App B: cool-tts ]
        │                                 │                              │
        │ ── 1. Creates file in app space ──>                            │
        │    (~/.cache/cool-ebook/tmp.wav)│                              │
        │                                 │                              │
        │ ── 2. X11 Intent: sys.TransferFile ──────────────────────────> │
        │    { src: "/path/tmp.wav",      │                              │
        │      target: "cool-tts" }       │                              │
        │                                 │                              │
        │                                 │ <── 3. Requests Link Auth ── │
        │                                 │                              │
        │                                 │ ── 4. link(src, target_path) │
        │                                 │       unlink(src) ─────────> │ (Now owns file)

Protocol Steps:

    Creation: cool-ebook writes the file to its isolated storage space (~/.cache/cool-ebook/out_1042.wav).

    Transfer Intent: cool-ebook emits an XClientMessage intent sys.TransferFile:
    JSON

    {
      "intent": "sys.TransferFile",
      "source_path": "~/.cache/cool-ebook/out_1042.wav",
      "target_app": "org.unix.cool-tts",
    }

    Mediation & Link: The system supervisor (sysd), running with elevated privilege relative to app sandboxes, verifies permissions, hard-links the inode into cool-tts's storage space (~/.cache/cool-tts/inbound_8801.wav), and unlinks it from cool-ebook's directory.

    Zero Copy: No data is read or written to disk. Only inode reference counts change. cool-tts now owns the file.


### 8.3. Media Streams
+-------------------+                               +-------------------+
|  App A (Producer) |                               | App B (Consumer)  |
+---------+---------+                               +---------+---------+
          |                                                   |
          | 1. Control Intent: media.ConnectStream             |
          +---------------------> [ Central Bus ] ------------>|
          |                       (DISPLAY=:0)                |
          |                                                   |
          | 2. Handshake Response: Socket FD / Endpoint       |
          |<--------------------- [ Central Bus ] <-----------+
          |                                                   |
          |                                                   |
          +===================================================+
             3. Direct Peer-to-Peer Stream (Unix Socket / TCP / SSH)
                Zero central server overhead / Zero X11 saturation

| Transport Scenario | Channel Mechanism | Disintermediation Strategy |
| :-- | :-- | :-- |
| Local Device | Unix Socket | App A sends media.ConnectStream, App B is offered a connection and a socket, App A gets the other end of the socket |
| High Speed | POSIX Shared Memory | App A sends a shared memory file descriptor over the unix socket |
| Cross Device | SSH Tunnel / Cleartext TCP | App A sends media.ConnectStream and gets the same socket back, but its a network socket |

Thus, the XINTENT router and the matchbox-service-lighter have to open sockets like `$XDG_RUNTIME_DIR/xintent-broker.sock` on their respective devices and signal the processes that want to send streams to request their side of the socket.  if it turns out the processes are on the same device, it would be a unix socket and they can use SHM.  if it turns out theyre on different devices, its probably an ssl socket.

# 9. How This System Will Come About
### 9.1 Web First
* start with the http bridge serving intents on :12345
* write a bunch of .toml wrappers applying intents to programs
* publish the matchbox202x javascript package so matchbox202x.intent({}) can pop open a big yellow attempted to connect to localhost warning
* put a bunch of app packages in /usr/local/lib/matchboxes 
* matchbox202x launch --app cool-ebooks
* while in one sense x11 is an optimization not an initial requirement, it is necessary to ensure that when matchbox202x launch --app cool-ebooks shoves the html into a browser launched remotely, matchbox202x gets the DISPLAY from the ssh -X and routes intents back to the same session as the DISPLAY
* index.toml would actually be called matchbox.toml to be next to pyproject.toml 

### 9.2 Android Enclave
* matchbox202x app on fdroid that loads html cards and provides localhost:12345, maps intents to android intents, and sideloads packages from /Matchbox
* matchbox202x app does a ssh -X to user-laptop, and allows apps from user-laptop to display html cards

### 9.3 X modifications
* once everyone is using matchbox202x, the planned fast path can be implemented, and the unix desktop can be what it should have been in the 1990's
* the X extension that should have existed no later than 2010, XHTML, that injects a window.xhtml.event() and window.xhtml.onevent in the html card and specifies X events in the html backend process, disappears XHTML windows if the html backend closes, and so on, is still needed regardless of how long the poetteringware developers play with wayland
* XAUDIO needs some more features but it was the most requested feature in the 90's that ssh -X would include speakers in the session
* XSECURE: coping with your ex-secure desktop you connected to the network.  check sender ids, dont give events to unauthorized processes, check the authoriation matrix against the uid across the socket, a pam token, etc.

### 9.4 Security
* the initial http bridge server has to hold a list of launched keys and serve localhost:12345/_sys/launch_key exactly once, the http bridge client library has to grab the key, put it in LocalStorage, then if it isnt available, complain that Error: Can't open display: localhost:10.0
* to prevent LocalStorage and BroadcastChannel collisions, the http bridge server has to keep track of allocating :5xxxx for cool-app html and keys
* when process 9000 sends `wm.Close` to window 0x420's parent frame, xsecure asks matchbox202x/compiz202x to pop open a uac prompt `[allowAndStore] [allow] [reject] [ignore] [disconnect]` and after `allowAndStore` the user has to go into xsecure.toml or through the xsecure card to see what authentications and authorizations there are