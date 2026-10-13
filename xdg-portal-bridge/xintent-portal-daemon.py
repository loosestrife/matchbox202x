#!/usr/bin/env python3
"""
XIntent XDG Desktop Portal Bridge
---------------------------------
Intercepts Linux FileChooser requests (from Firefox, Chrome, VS Code, etc.) over
D-Bus (org.freedesktop.portal.FileChooser) and delegates file selection to the
XIntent bus via `fs.PickFile` natively using the Python client library (libxintent).

Formats the requesting application's identity into the User-Agent HTTP header:
  User-Agent: <app_id> (Linux; xintent-portal-bridge; pid=<pid>)
"""

import os
import sys
import re
import random
import time
import tempfile
import json
from pathlib import Path

# Add x11-promises client library directory to Python path
x11_promises_candidates = [
    Path(__file__).resolve().parent.parent / "x11-promises",
    Path(__file__).resolve().parent / "x11-promises",
    Path(__file__).resolve().parent.parent.parent / "x11-promises",
]
for candidate in x11_promises_candidates:
    if candidate.exists():
        x11_promises_dir = str(candidate)
        if x11_promises_dir not in sys.path:
            sys.path.insert(0, x11_promises_dir)
        break

import dbus
import dbus.service
import dbus.mainloop.glib

try:
    from gi.repository import GLib
    HAS_GLIB = True
except ImportError:
    HAS_GLIB = False
    GLib = None

try:
    from xintent import XIntentXlibClient
    HAS_XINTENT_XLIB = True
except Exception as e:
    sys.stderr.write(f"[xintent-portal] Warning: Could not import xintent python-xlib client: {e}\n")
    HAS_XINTENT_XLIB = False
    XIntentXlibClient = None

BUS_NAME = "org.freedesktop.impl.portal.desktop.xintent"
OBJECT_PATH = "/org/freedesktop/portal/desktop"
XINTENT_TARGET_APP = os.getenv("XINTENT_TARGET_APP", "flammenwerfer-phone")
XINTENT_BUS_URL = os.getenv("XINTENT_BUS_URL", "http://localhost:8080")


class XIntentFileChooserPortal(dbus.service.Object):
    def __init__(self):
        self.bus = dbus.SessionBus()
        bus_name = dbus.service.BusName(BUS_NAME, self.bus)
        super().__init__(bus_name, OBJECT_PATH)

        self.x11_client = None
        if HAS_XINTENT_XLIB and os.environ.get("DISPLAY"):
            try:
                self.x11_client = XIntentXlibClient(app_id="xdg-portal-bridge")
                print(f"[xintent-portal] Native XIntent Python client initialized on window {hex(self.x11_client.client_win.id)}")
            except Exception as e:
                print(f"[xintent-portal] Failed to initialize native XIntent Python client: {e}")

        print(f"[xintent-portal] Portal service registered on D-Bus: {BUS_NAME}")
        print(f"[xintent-portal] Target device/app: {XINTENT_TARGET_APP}")

    def _get_caller_info(self, sender_unique_name, app_id):
        pid = None
        try:
            dbus_info = self.bus.get_object('org.freedesktop.DBus', '/org/freedesktop/DBus')
            dbus_iface = dbus.Interface(dbus_info, 'org.freedesktop.DBus')
            pid = int(dbus_iface.GetConnectionUnixProcessID(sender_unique_name))
        except Exception as e:
            print(f"[xintent-portal] Warning: Failed to resolve PID for {sender_unique_name}: {e}")

        exe_name = None
        if pid:
            try:
                exe_path = os.readlink(f"/proc/{pid}/exe")
                exe_name = os.path.basename(exe_path)
            except Exception:
                pass

        caller_app = app_id if app_id else (exe_name if exe_name else "unknown-app")
        return caller_app, pid

    @dbus.service.method("org.freedesktop.impl.portal.FileChooser",
                         in_signature="oassa{sv}", out_signature="ua{sv}",
                         sender_keyword="sender")
    def OpenFile(self, handle, app_id, parent_window, options, sender=None):
        caller_app, pid = self._get_caller_info(sender, app_id)
        
        # Build User-Agent header: App ID + Platform Comment
        pid_str = f"; pid={pid}" if pid else ""
        user_agent = f"{caller_app} (Linux; xintent-portal-bridge{pid_str})"
        
        print(f"[xintent-portal] OpenFile invoked by app='{caller_app}' (pid={pid})")
        print(f"[xintent-portal] User-Agent: '{user_agent}'")

        payload = {
            "intent": "fs.PickFile",
            "app": XINTENT_TARGET_APP,
            "holdOpenForWrite": True,
            "Accept": "*",
            "controlWord": 1,
            "headers": {
                "User-Agent": user_agent,
                "X-Forwarded-By": "xintent-desktop-portal",
                "X-Channel-Control": "SYN"
            }
        }

        # Try sending natively over XIntent Python Xlib Client first
        if self.x11_client:
            try:
                res_file_name, res_file_bytes = self._send_native_xintent(payload)
                if res_file_bytes:
                    return self._return_dbus_success(res_file_name, res_file_bytes)
            except Exception as e:
                print(f"[xintent-portal] Native X11 XIntent dispatch failed: {e}. Falling back to HTTP bridge...")

        # Fallback to HTTP Bridge if native client unavailable/failed
        res_file_name, res_file_bytes = self._send_http_xintent(payload, user_agent)
        if res_file_bytes:
            return self._return_dbus_success(res_file_name, res_file_bytes)

        print("[xintent-portal] No file data received (pick cancelled or failed)")
        return dbus.Struct((dbus.UInt32(1), dbus.Dictionary({}, signature="sv")), signature="ua{sv}")

    @dbus.service.method("org.freedesktop.impl.portal.FileChooser",
                         in_signature="oassa{sv}", out_signature="ua{sv}",
                         sender_keyword="sender")
    def SaveFile(self, handle, app_id, parent_window, options, sender=None):
        print(f"[xintent-portal] SaveFile requested by app_id='{app_id}'")
        return self.OpenFile(handle, app_id, parent_window, options, sender=sender)

    def _send_native_xintent(self, payload, timeout_sec=30):
        """Sends fs.PickFile natively over X11 IPC using XIntentXlibClient python library."""
        router_id = self.x11_client.get_router_win_id()
        if not router_id:
            raise RuntimeError("No xintent-router window found on X11 display")

        tx_id = random.randint(1, 16777215)
        response_data = {}

        def on_response(frame):
            nonlocal response_data
            response_data = frame

        # Register temporary handlers for response events
        self.x11_client.handlers["fs.PickFileResponse"] = on_response
        self.x11_client.handlers["PickFileResponse"] = on_response

        print(f"[xintent-portal] Sending native X11 fs.PickFile to router {hex(router_id)} (tx_id={tx_id})")
        self.x11_client.send_intent(target_win_id=router_id, payload=payload, tx_id=tx_id)

        start_time = time.time()
        while time.time() - start_time < timeout_sec:
            self.x11_client.process_events_once()
            if response_data:
                break
            time.sleep(0.02)

        self.x11_client.handlers.pop("fs.PickFileResponse", None)
        self.x11_client.handlers.pop("PickFileResponse", None)

        if not response_data:
            print("[xintent-portal] Native X11 fs.PickFile response timed out")
            return "picked_file", None

        # Parse response frame and data blob
        resp_payload = response_data.get("payload", {})
        data_blob = response_data.get("data_blob", 0)

        file_data = None
        file_name = "picked_desktop_file"

        if data_blob:
            try:
                blob_content = self.x11_client.blob_read(data_blob)
                if isinstance(blob_content, dict):
                    file_name = blob_content.get("name") or file_name
                    file_data = blob_content.get("data")
                elif isinstance(blob_content, (bytes, bytearray)):
                    file_data = bytes(blob_content)
            except Exception as e:
                print(f"[xintent-portal] Error reading response data_blob {hex(data_blob)}: {e}")

        if not file_data and isinstance(resp_payload, dict):
            if "blob" in resp_payload:
                blob_obj = resp_payload["blob"]
                file_name = blob_obj.get("name", file_name)
                d = blob_obj.get("data")
                if blob_obj.get("_dataType") == "base64" and isinstance(d, str):
                    import base64
                    file_data = base64.b64decode(d)
                elif isinstance(d, str):
                    file_data = d.encode("utf-8")
                elif isinstance(d, (bytes, bytearray)):
                    file_data = bytes(d)

        return file_name, file_data

    def _send_http_xintent(self, payload, user_agent):
        """Fallback HTTP POST dispatch to XIntent HTTP bridge."""
        import urllib.parse
        import urllib.request

        encoded_target = urllib.parse.quote(XINTENT_TARGET_APP)
        request_url = f"{XINTENT_BUS_URL}/intent/fs/PickFile?app={encoded_target}"
        json_data = json.dumps(payload).encode("utf-8")

        headers = {
            "User-Agent": user_agent,
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "*/*",
            "X-Forwarded-By": "xintent-desktop-portal",
            "X-Channel-Control": "SYN"
        }

        try:
            req = urllib.request.Request(request_url, data=json_data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=30) as resp:
                status_code = resp.status
                raw_bytes = resp.read()
                content_type = resp.headers.get("Content-Type", "")

            if status_code in (200, 201):
                return self._parse_http_response(raw_bytes, content_type)
        except Exception as e:
            print(f"[xintent-portal] HTTP bridge fallback error: {e}")

        return "picked_file", None

    def _parse_http_response(self, raw_bytes, content_type):
        if not raw_bytes:
            return "picked_file", None

        try:
            str_data = raw_bytes.decode("utf-8")
            json_obj = json.loads(str_data)
            if json_obj.get("status") == "ok" and "blob" in json_obj:
                import base64
                blob = json_obj["blob"]
                file_name = blob.get("name", "picked_file")
                data_str = blob.get("data", "")
                data_bytes = base64.b64decode(data_str) if blob.get("_dataType") == "base64" else data_str.encode("utf-8")
                return file_name, data_bytes
        except Exception:
            pass

        boundary = None
        m = re.search(r'boundary=([^\s;]+)', content_type, re.IGNORECASE)
        if m:
            boundary = m.group(1).strip('"')

        if not boundary:
            raw_str = raw_bytes[:512].decode("latin1", errors="ignore")
            for line in raw_str.splitlines():
                if "MatchboxFrameBoundary" in line:
                    boundary = line.strip().lstrip("-").rstrip("-").strip()
                    break

        if boundary:
            delimiter = f"--{boundary}".encode("latin1")
            parts = raw_bytes.split(delimiter)
            found_name = "picked_desktop_file"

            for part in parts:
                if not part or part == b"--\r\n" or part == b"--":
                    continue
                header_end = part.find(b"\r\n\r\n")
                if header_end != -1:
                    headers_text = part[:header_end].decode("utf-8", errors="ignore")
                    body_bytes = part[header_end + 4:].rstrip(b"\r\n")

                    cd_match = re.search(r'filename\s*=\s*"?([^";\r\n]+)"?', headers_text, re.IGNORECASE)
                    if cd_match:
                        found_name = cd_match.group(1).strip()

                    if "application/json" not in headers_text.lower() and body_bytes:
                        return found_name, body_bytes

        return "picked_desktop_file", raw_bytes

    def _return_dbus_success(self, file_name, file_bytes):
        tmp_dir = os.path.join(tempfile.gettempdir(), "xintent_picked_files")
        os.makedirs(tmp_dir, exist_ok=True)
        saved_file_path = os.path.join(tmp_dir, file_name)

        with open(saved_file_path, "wb") as f:
            f.write(file_bytes)

        file_uri = f"file://{os.path.abspath(saved_file_path)}"
        print(f"[xintent-portal] Picked file saved to: {file_uri} ({len(file_bytes)} bytes)")

        results = dbus.Dictionary({
            "uris": dbus.Array([file_uri], signature="s"),
            "writable": dbus.Boolean(True)
        }, signature="sv")

        return dbus.Struct((dbus.UInt32(0), results), signature="ua{sv}")


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    portal = XIntentFileChooserPortal()
    if HAS_GLIB and GLib:
        loop = GLib.MainLoop()
        try:
            loop.run()
        except KeyboardInterrupt:
            print("\n[xintent-portal] Portal daemon stopped.")
    else:
        print("[xintent-portal] Portal daemon running. Press Ctrl+C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\n[xintent-portal] Portal daemon stopped.")


if __name__ == "__main__":
    main()
