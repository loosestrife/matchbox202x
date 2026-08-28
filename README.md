# UNIX Desktop & Application Platform Specification
**Version 0.1.0-DRAFT**  
**Directory:** `matchbox202x`  
**Status:** Proposal / Reference Specification

---

## High-Level Architectural Description

### Executive Overview
The modern Linux and UNIX desktop ecosystem suffers from severe fragmentation, redundant abstractions, and excessive resource overhead. Over the past two decades, traditional system interfaces have been systematically obscured by multi-layered IPC daemons (`dbus-daemon`), custom compositors, sandboxing runtimes (Flatpak, Snap), language-isolated package manifests (`package.json`, `Cargo.toml`, `pyproject.toml`), and heavy web-runtime wrappers.

This specification defines a unified, lightweight desktop platform constructed entirely from proven, off-the-shelf POSIX and X11 primitives. It proves that a fully capable, sandboxed, intent-driven, mobile/tablet-friendly operating system requires zero custom IPC protocols, no dedicated system bus daemons, and no bespoke package management infrastructure.

+-----------------------------------------------------------------------+
|                    Application Package (.zip / ELF)                   |
|                        Manifest: index.toml                           |
+-----------------------------------------------------------------------+
|   Web Cards (HTML/CSS)   |   Programs and Scripts   |   ELF Plugins   |
+--------------------------+----------------------+---------------------+
│                 libplatform (IPC Bridge)                              |
|          X11 ClientMessage (Intents, Events, Channels)                |
+-----------------------------------------------------------------------+
|                        X11 Display Server                             |
|    Session Bus (:0)  <------------------------->  System Bus (:99)    |
|   (Graphics/Input)                                 (Headless)         |
+-----------------------------------------------------------------------+
|             Window Manager: Matchbox (Card-Deck Layout)               |
+-----------------------------------------------------------------------+
|       POSIX Filesystem Layer (Zero-Copy Hard-Link Transfers)          |
+-----------------------------------------------------------------------+


### Core Design Philosophy
1. **Standardized Manifest (`index.toml`):** Application metadata, runtime dependencies (Nix/Pypi/NPM/Cpan), file permissions, visual UI cards, and external command surfaces are declared in a single, developer-friendly TOML file with minimal differences from (`Cargo.toml`, `pyproject.toml`, `package.json`).
2. **Universal IPC Surface (`libplatform`):** Applications communicate via **Intents** (directed requests) and **Events** (state broadcasts). `libplatform` abstracts wire-level X11 messages into canonical JSON streams over `stdin`/`stdout` for scripts, standard C API structs for ELF objects, websockets for the http bridge, window.libserver.onMyEvent for html cards
2. **The Display Server is the IPC Bus:** Following single control multiple data, native X11 `ClientMessage` events handle all intent routing, event broadcasting, and service discovery.  Therefore your system has exactly two event/intent buses, DISPLAY:99 and DISPLAY:0, which, get bridged to http://localhost:12345 and http://localhost:12354 for slow-path convenience
3. **Card-Deck Window Orchestration:** User interface navigation can use existing 1-window managers (`matchbox-window-manager`) where top-level application windows map to "Cards" in a full-screen deck.  Cards can either be filled with html, or, filled with normal x stuff.
4. **Decoupled HTML/CSS Visual Layer:** The simplest card is actually an HTML file rendered by a system web browser attached to the X server.  System styling is then inherited directly via `_XSETTINGS_SETTINGS`.
5. **Zero-Copy POSIX Data Transfer:** Large inter-app file transfers bypass IPC buffer copies entirely by leveraging POSIX filesystem hard-links (`link(2)`) and atomic unlinks (`unlink(2)`), coordinated through the intent server, seamlessly becoming scp between devices.  Inter-app streaming goes unix domain sockets or tls sockets configured by the intent server, and apps connected with a unix domain socket can upgrade that to posix shared memory.
6. **Zero Invention Design** matchbox202x doesn't invent anything, because everything has already been invented.

---

## 1. System Architecture & Bus Routing
### 1.1 User's Distributed Lifestyle
User is running a session on user-phone and has an ssh -X to user-laptop in the coffee shop with him and an ssh -X to user-desktop at home over tailscale.  User is running cool-ebook off user-laptop where the files are but cool-ebook's html card is running on user-phone.
* Naively, tts intents stream locally from cool-ebook's html card to cool-tts, burning user-phone's battery and lagging becaue cool-tts is slower on user-phone than on user-laptop.
* User needs to run platform-discover-services in its .bashrc when it logs in to user-laptop over ssh -X in order for the session server to know what services user-laptop provides.  Non local services get a little connect icon and are labeled user-desktop:cool-tts for the purpose of libserver intent --intent ui.TextToSpeech --text "my string" --app user-desktop:cool-tts

### 1.2 Web First
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

### 1.3 Session and System Buses (`DISPLAY=:0` and `DISPLAY=:99`)
* this is an already existing universal ipc framework
* X messages are the fastest way to communicate and libraries exist everywhere
* X needed a plugged in web browser for html windows in the 1990's though there were attempts at ps and pdf

### 1.4 Write Your app.toml Card Today to Access Your App through Intents
* put `app.toml` in `libserver/` alongside all the other apps.  `libserver sync` will do the `uv sync` thing of ensuring that every app is ready to go with a libserver intent --app localhost:app --intent appIntent --data "my data"
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
[package]
id = "org.unix.editor"
version = "1.0.0"
name = "Simple Text Editor"
description = "POSIX-compliant web-card text editor"
exec = "bin/app_binary" # Optional executable binary path, but elf binaries can have an index_toml segment instead

[dependencies]
"nix:python3" = "3.14"
"python:torch" = "2.13"
"sys:firefox" = "128 (compatible; chromium 365)" # my cards need css7

[permissions]
network = false
filesystem = ["~/Documents"]

# User Interface Card Declarations
[[cards]]
id = "main"
path = "cards/index.html"
title = "Editor Main"

[[cards]]
id = "settings"
path = "cards/settings.html"
title = "Preferences"

# Intent Receivers (External Command Surface)
[intents.receivers]
"ui.TextProcess" = { exec = "bin/app_binary" }
"file.Open" = { handler = "cards/index.html" }

# System / Custom Event Subscriptions
[events.subscribers]
"sys.DisplayRotated" = { exec = "bin/app_binary" }
"net.StateChanged"   = { handler = "cards/index.html" }
```

---

## 3. Intent & Event Wire Protocol (X11 Primitives)

Intents (requesting an action) and Events (broadcasting a state change) are transmitted across the X11 server using native `ClientMessage` structures and X Properties.

### 3.1 Message Atoms
The server MUST register the following core atoms via `XInternAtom`:
* `UNIX_INTENT`
* `UNIX_EVENT`
* `UNIX_PAYLOAD_ATOM`
* `_XSETTINGS_SETTINGS`

### 3.2 Canonical Data Models
An Intent or Event is sent via `XSendEvent` as an `XClientMessageEvent` formatted with `format = 32`:

+-----------------------------------------------------------------------+
|                       XClientMessageEvent                             |
+-----------------------------------------------------------------------+
| type        : ClientMessage                                           |
| window      : Target Window XID (or DefaultRootWindow for Broadcast)  |
| message_type: Atom("UNIX_INTENT") or Atom("UNIX_EVENT")               |
| format      : 32                                                      |
| data.l[0]   : Atom representing Action/Event Name (e.g., ui.Text)     |
| data.l[1]   : Atom representing Payload Data (UNIX_PAYLOAD_ATOM)      |
| data.l[2]   : Sender Window XID                                       |
| data.l[3]   : Target App ID Atom (0 if un-targeted broadcast)         |
| data.l[4]   : Sequence / Message ID Channel                           |
+-----------------------------------------------------------------------+

### 3.3 Large Payloads (X Selection / Property Protocol)
If the payload exceeds what fits inside the 32-bit `ClientMessage` fields:
1. The sender sets an X Property (`UNIX_PAYLOAD_ATOM`) on its own window containing the canonical JSON string.
2. `data.l[1]` passes the property Atom name.
3. The receiver queries the property data via `XGetWindowProperty` and deletes it upon receipt.

---
# 4. UI Rendering, Web Cards, & Window Management
### 4.1 Tablet Card-Deck Window Manager
Top-level windows are "Cards".  If an app has good "Cards", it can run on a phone.

### 4.2 Web Rendering & XSettings
Programs may generate UI by providing HTML/CSS markup to a system-wide Web Browser process using XEmbed socket frames.

Inter-Card Communication: HTML Cards within the same app session communicate state using standard web BroadcastChannel APIs.  Otherwise, they only communicate by sending intents from their buttons back to their app, exactly as if they were ordinary X windows and the app would recieve X events exactly the same way.

System Styling: The shared Web Browser reads the system themes, DPI, and scaling directly from the _XSETTINGS_SETTINGS root window property.

# 5. Canonical Data Models
### 5.1 JSON Payload Schema (Stdin/Stdout / Sockets)

Processes receiving intents via stdin or Unix domain sockets receive line-delimited JSON (NNJSON) matching this structure:

{
  "type": "intent",
  "action": "ui.TextProcess",
  "sender": 10485763,
  "timestamp": 1772276400,
  "payload": {
    "text": "Selected text to process",
    "mime": "text/plain"
  }
}

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


# 8. Zero-Copy File Ownership Transfer & Synchronous Request/Response
### 8.1 File Ownership Transfer Protocol (sys.TransferFile)

When an application generates large payloads (e.g., TTS audio streams, rendered video, compiled binaries) that must be passed to another app without copying data across disks, ownership is transferred atomically via the platform supervisor using POSIX hard links.

[ App A: cool-ebook ]         [ System Mediator: sysd ]         [ App B: cool-tts ]
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
      "read_only": false
    }

    Mediation & Link: The system supervisor (sysd), running with elevated privilege relative to app sandboxes, verifies permissions, hard-links the inode into cool-tts's storage space (~/.cache/cool-tts/inbound_8801.wav), and unlinks it from cool-ebook's directory.

    Zero Copy: No data is read or written to disk. Only inode reference counts change. cool-tts now owns the file.

### 8.2 Synchronous Request/Response Pattern (sendAwaitFullResponse)

To allow asynchronous X11 ClientMessage flows to act like synchronous API calls (e.g., sending text to TTS and waiting for the rendered audio response), messages include an immutable message_id channel tag passed in data.l[4].
```JSON

{
  "intent": "sys.SendData",
  "app": "org.unix.cool-ebook",
  "disposition": "final-response",
  "channel": "0x7F8A9B11",
  "data": {
    "file_path": "~/.cache/cool-ebook/inbound_speech.wav",
    "duration_ms": 1420
  }
}
```

### 8.3. Disintermediating the Intent Server for Media Streams
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

# 9. How This System Will Come About
### 9.1 Web First
* start with libplatform.  its actual name would be matchbox202x and it would be a javascript express server serving intents on :12345
* write a bunch of .toml wrappers applying intents to programs
* publish the matchbox202x javascript package so matchbox202x.intent({}) can pop open a big yellow attempted to connect to localhost warning
* put a bunch of app packages in /usr/local/lib/matchboxes 
* matchbox202x launch --app cool-ebooks
* while in one sense x11 is an optimization not an initial requirement, it is necessary to ensure that when matchbox202x launch --app cool-ebooks shoves the html into a browser launched remotely, matchbox202x gets the DISPLAY from the ssh -X and routes intents back to the same session as the DISPLAY

### 9.2 Android Enclave
* matchbox202x app on fdroid that loads html cards and provides localhost:12345, maps intents to android intents, and sideloads packages from /Matchbox
* matchbox202x app does a ssh -X to user-laptop, and allows apps from user-laptop to display html cards

### 9.3 X modifications
* once everyone is using matchbox202x, the planned fast path can be implemented, and the unix desktop can be what it should have been in the 1990's