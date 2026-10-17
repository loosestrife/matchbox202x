# Matchbox202x & XIntent Architecture Manual

## Javascript Engines
- **Node.js**: Standard Node.js runtimes **cannot receive** file descriptors (`SCM_RIGHTS`) over UNIX domain sockets. Attempting to receive regular-file file descriptors on a Node.js libuv socket causes a runtime abort (`SIGABRT`).
- **Bun**: **Bun** fully supports receiving file descriptors via `bun:ffi` (see `lib/fdpass-bun.js`).  Any core services that must receive `Content-Encoding: fd-rights` must run under Bun.
