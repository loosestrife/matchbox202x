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
import random
import sys
import time
from pathlib import Path

import portal_helpers

# Add x11-promises client library directory to Python path
for candidate in (
    Path(__file__).resolve().parent.parent / "x11-promises",
    Path(__file__).resolve().parent / "x11-promises",
    Path(__file__).resolve().parent.parent.parent / "x11-promises",
):
    if candidate.exists():
        x11_promises_dir = str(candidate)
        if x11_promises_dir not in sys.path:
            sys.path.insert(0, x11_promises_dir)
        break

import dbus
import dbus.mainloop.glib
import dbus.service

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
            dbus_info = self.bus.get_object("org.freedesktop.DBus", "/org/freedesktop/DBus")
            dbus_iface = dbus.Interface(dbus_info, "org.freedesktop.DBus")
            pid = int(dbus_iface.GetConnectionUnixProcessID(sender_unique_name))
        except Exception as e:
            print(f"[xintent-portal] Warning: Failed to resolve PID for {sender_unique_name}: {e}")

        exe_name = None
        if pid:
            try:
                exe_name = os.path.basename(os.readlink(f"/proc/{pid}/exe"))
            except Exception:
                pass

        caller_app = app_id or exe_name or "unknown-app"
        return caller_app, pid

    @dbus.service.method("org.freedesktop.impl.portal.FileChooser",
                         in_signature="oassa{sv}", out_signature="ua{sv}",
                         sender_keyword="sender")
    def OpenFile(self, handle, app_id, parent_window, options, sender=None):
        caller_app, pid = self._get_caller_info(sender, app_id)
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

        if self.x11_client:
            try:
                res_file_name, res_file_bytes = self._send_native_xintent(payload)
                if res_file_bytes:
                    return self._return_dbus_success(res_file_name, res_file_bytes)
            except Exception as e:
                print(f"[xintent-portal] Native X11 XIntent dispatch failed: {e}. Falling back to HTTP bridge...")

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

    def _await_native_response(self, router_id: int, payload: dict, tx_id: int, timeout_sec: int) -> dict:
        response_data = {}

        def on_response(frame):
            nonlocal response_data
            response_data = frame

        self.x11_client.handlers["fs.PickFileResponse"] = on_response
        self.x11_client.handlers["PickFileResponse"] = on_response
        try:
            self.x11_client.send_intent(target_win_id=router_id, payload=payload, tx_id=tx_id)
            start_time = time.time()
            while time.time() - start_time < timeout_sec:
                self.x11_client.process_events_once()
                if response_data:
                    break
                time.sleep(0.02)
        finally:
            self.x11_client.handlers.pop("fs.PickFileResponse", None)
            self.x11_client.handlers.pop("PickFileResponse", None)
        return response_data

    def _send_native_xintent(self, payload, timeout_sec=30):
        """Sends fs.PickFile natively over X11 IPC using XIntentXlibClient python library."""
        router_id = self.x11_client.get_router_win_id()
        if not router_id:
            raise RuntimeError("No xintent-router window found on X11 display")

        tx_id = random.randint(1, 16777215)
        print(f"[xintent-portal] Sending native X11 fs.PickFile to router {hex(router_id)} (tx_id={tx_id})")
        response_data = self._await_native_response(router_id, payload, tx_id, timeout_sec)
        if not response_data:
            print("[xintent-portal] Native X11 fs.PickFile response timed out")
            return "picked_file", None

        return portal_helpers.extract_native_response_file(self.x11_client, response_data)

    def _send_http_xintent(self, payload, user_agent):
        """Fallback HTTP POST dispatch to XIntent HTTP bridge."""
        return portal_helpers.dispatch_http_pick_file(XINTENT_BUS_URL, XINTENT_TARGET_APP, payload, user_agent)

    def _parse_http_response(self, raw_bytes, content_type):
        return portal_helpers.parse_http_pick_response(raw_bytes, content_type)

    def _return_dbus_success(self, file_name, file_bytes):
        file_uri = portal_helpers.save_picked_file_to_temp(file_name, file_bytes)
        results = dbus.Dictionary({
            "uris": dbus.Array([file_uri], signature="s"),
            "writable": dbus.Boolean(True)
        }, signature="sv")
        return dbus.Struct((dbus.UInt32(0), results), signature="ua{sv}")


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    _portal = XIntentFileChooserPortal()
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
