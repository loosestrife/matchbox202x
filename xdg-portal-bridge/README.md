# XIntent XDG Desktop Portal Bridge (`/xdg-portal-bridge`)

This bridge connects Linux desktop applications (such as **Firefox**, Chrome, VS Code, and GIMP) to the **XIntent Bus** via the Linux **XDG Desktop Portal** system (`org.freedesktop.portal.FileChooser`).

When an application on Linux opens a file picker dialog, this bridge intercepts the request and injects an `fs.PickFile` intent directly into the bus natively using the Python client library (`libxintent`).

---

## 🚀 Features

- **Native Python Client Integration**: Connects directly to `xintent-router` over X11 IPC using the monorepo's shared `libxintent` / `XIntentXlibClient` Python library (`x11-promises/xintent.py`).
- **`uv` Package Manager**: Specified in `pyproject.toml` with dependencies (`dbus-python`, `PyGObject`, `python-xlib`), allowing execution via `uv run python xintent-portal-daemon.py`.
- **App Identity Tracking**: Identifies the calling desktop app (e.g., `org.mozilla.firefox`) and embeds it into the HTTP `User-Agent` header:
  ```http
  User-Agent: org.mozilla.firefox (Linux; xintent-portal-bridge; pid=14205)
  ```
- **Auto-Loaded by `cool-service-lighter`**: `cool-service-lighter` detects `pyproject.toml` and auto-spawns `xdg-portal-bridge` via `uv run` right alongside `cool-http-bridge`.
- **Seamless Streaming**: Unpacks multipart (`MatchboxFrameBoundary`) or JSON file payloads returned by Flammenwerfer and saves the picked file to local temporary storage (`/tmp/xintent_picked_files/`) for the calling Linux app.

---

## 🏃 Running with `uv`

Run manually using `uv`:

```bash
cd xdg-portal-bridge
uv run xintent-portal-daemon.py
```

Or let `cool-service-lighter` launch it automatically:

```bash
node cool-service-lighter/index.js
```

---

## 📥 Installation

Run the provided installation script:

```bash
chmod +x xdg-portal-bridge/install.sh
./xdg-portal-bridge/install.sh
```

This installs:
- `xintent.portal` -> `~/.local/share/xdg-desktop-portal/portals/`
- `xdg-portal-bridge.service` -> `~/.config/systemd/user/`

---

## 🧪 Testing with Firefox

1. Launch Firefox with Portal support:
   ```bash
   GTK_USE_PORTAL=1 firefox
   ```

2. Click any file upload input in Firefox. The request will automatically route to Flammenwerfer via `fs.PickFile`, and the file selected on your Android device will be passed straight to Firefox!
