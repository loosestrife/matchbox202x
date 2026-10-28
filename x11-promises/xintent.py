#!/usr/bin/env python3
"""
xintent.py - Python client library for Matchbox / XIntent services.

Provides both:
1. XIntentServer: Dual-mode server (NNJSON stdin/stdout pipe mode AND X11 IPC window mode).
2. XIntentXlibClient: Native X11 IPC mode using python-xlib (mirroring xintent.js).
"""

import json
import logging
import os
import select
import sys
import time

logging.basicConfig(level=logging.INFO, format="[%(asctime)s %(levelname)s %(name)s] %(message)s")
logger = logging.getLogger("libxintent")

try:
    from xintent_xlib import XIntentXlibClient, SYN, FIN, SYN_FIN
    HAS_XLIB_CLIENT = True
except ImportError:
    XIntentXlibClient = None
    HAS_XLIB_CLIENT = False
    SYN = 1
    FIN = 2
    SYN_FIN = 3


def _extract_frame_intent_name(frame: dict):
    direct = frame.get("intent") or frame.get("action")
    if direct:
        return direct
    payload = frame.get("payload")
    if isinstance(payload, dict):
        return payload.get("intent") or payload.get("action")
    return None


class XIntentServer:
    """
    Matchbox XIntent Service Server.

    Handles incoming intents over both stdin NNJSON frames and native X11 window IPC events,
    dispatching them to registered intent handlers.
    """

    def __init__(self, app_id: str = "cool-tts", toml_path=None):
        self.app_id = app_id
        self.toml_path = toml_path or self._find_matchbox_toml()
        self.handlers = {}
        self.x11_client = None

        self._try_register_x11_window()

    def _find_matchbox_toml(self):
        base_dir = os.path.dirname(__file__)
        candidates = (
            "matchbox.toml",
            os.path.join(base_dir, "matchbox.toml"),
            os.path.join(base_dir, "../cool-tts/matchbox.toml"),
        )
        for path in candidates:
            if os.path.exists(path):
                return path
        return None

    def _load_and_register_toml(self):
        if not self.toml_path or not os.path.exists(self.toml_path):
            return
        with open(self.toml_path, "r", encoding="utf-8") as f:
            toml_content = f.read()
        self.x11_client.register_matchbox_toml(toml_content)
        sys.stderr.write(
            f"[libxintent.py] Registered MATCHBOX_TOML on X11 window {hex(self.x11_client.client_win.id)} for '{self.app_id}'\n"
        )
        sys.stderr.flush()

    def _try_register_x11_window(self):
        if not os.environ.get("DISPLAY"):
            return
        try:
            x11_path = os.path.abspath(os.path.dirname(__file__))
            if x11_path not in sys.path:
                sys.path.insert(0, x11_path)

            from xintent_xlib import XIntentXlibClient as ClientCls
            if ClientCls:
                self.x11_client = ClientCls(app_id=self.app_id)
                self._load_and_register_toml()
        except Exception as e:
            sys.stderr.write(f"[libxintent.py] Could not register X11 MATCHBOX_TOML: {e}\n")
            sys.stderr.flush()

    def on_intent(self, intent_name: str):
        """Decorator to register a handler function for an intent (e.g. 'ui.TextToSpeech')."""
        def decorator(func):
            self.register_handler(intent_name, func)
            return func
        return decorator

    def _sync_x11_handler(self, intent_name: str, handler):
        if hasattr(self.x11_client, "register_handler"):
            self.x11_client.register_handler(intent_name, handler)
        elif hasattr(self.x11_client, "on_intent"):
            self.x11_client.on_intent(intent_name)(handler)
        else:
            if not hasattr(self.x11_client, "handlers"):
                self.x11_client.handlers = {}
            self.x11_client.handlers[intent_name] = handler

    def register_handler(self, intent_name: str, handler):
        """Registers a handler function for an intent."""
        self.handlers[intent_name] = handler
        if self.x11_client:
            self._sync_x11_handler(intent_name, handler)

    def send_event(
        self,
        event_name: str,
        payload=None,
        channel=None,
        disposition: str = "final",
        status: str = "ok",
        **extra,
    ):
        """
        Sends an xevent / response frame back over stdout as double-newline JSON (NNJSON).
        """
        response_frame = {
            "intent": event_name,
            "event": event_name,
            "status": status,
            "disposition": disposition,
            "timestamp": int(time.time()),
        }
        if channel is not None:
            response_frame["channel"] = channel

        if isinstance(payload, dict):
            for k, v in payload.items():
                if k not in response_frame:
                    response_frame[k] = v
        elif payload is not None:
            response_frame["payload"] = payload

        response_frame.update(extra)
        sys.stdout.write(json.dumps(response_frame) + "\n\n")
        sys.stdout.flush()

    def _emit_handler_result(self, intent_name: str, channel, result):
        response_intent = f"{intent_name}Response"
        if isinstance(result, dict):
            disp = result.pop("disposition", "final")
            evt = result.pop("event", result.pop("intent", response_intent))
            res_status = result.pop("status", "ok")
            self.send_event(event_name=evt, payload=result, channel=channel, disposition=disp, status=res_status)
        else:
            self.send_event(event_name=response_intent, payload={"data": result}, channel=channel, disposition="final")

    def process_frame(self, frame: dict):
        """Processes a single parsed JSON frame received from stdin."""
        intent_name = _extract_frame_intent_name(frame)
        if not intent_name:
            return
        if intent_name not in self.handlers:
            logger.warning(f"[libxintent.py] No handler registered for intent '{intent_name}' in app '{self.app_id}'")
            return

        channel = frame.get("channel")
        try:
            result = self.handlers[intent_name](frame)
            if result is not None:
                self._emit_handler_result(intent_name, channel, result)
        except Exception as err:
            logger.error(f"[libxintent.py] Error executing handler for '{intent_name}': {err}", exc_info=True)
            self.send_event(
                event_name=f"{intent_name}Error",
                payload={"message": str(err)},
                channel=channel,
                disposition="error",
                status="error",
            )

    def _get_x11_fd(self):
        try:
            if self.x11_client and hasattr(self.x11_client, "x11") and hasattr(self.x11_client.x11, "disp"):
                return self.x11_client.x11.disp.display.socket.fileno()
        except Exception:
            pass
        return None

    def _drain_complete_frames(self, buffer: str) -> str:
        while "\n\n" in buffer:
            frame_str, buffer = buffer.split("\n\n", 1)
            frame_str = frame_str.strip()
            if frame_str:
                try:
                    self.process_frame(json.loads(frame_str))
                except json.JSONDecodeError as e:
                    sys.stderr.write(f"[libxintent.py] Invalid JSON frame: {e} in '{frame_str}'\n")
                    sys.stderr.flush()
        return buffer

    def _read_stdin_ready(self, buffer: str):
        chunk = sys.stdin.read(1)
        if not chunk:
            return False, buffer
        return True, self._drain_complete_frames(buffer + chunk)

    def _poll_io_step(self, stdin_open: bool, buffer: str, x11_fd):
        if self.x11_client:
            self.x11_client.process_events_once()

        rfds = ([sys.stdin] if stdin_open else []) + ([x11_fd] if x11_fd is not None else [])
        if not rfds:
            time.sleep(0.05)
            return stdin_open, buffer

        readable, _, _ = select.select(rfds, [], [], 0.05)
        if sys.stdin in readable:
            stdin_open, buffer = self._read_stdin_ready(buffer)
        if x11_fd is not None and x11_fd in readable and self.x11_client:
            self.x11_client.process_events_once()
        return stdin_open, buffer

    def run(self):
        """
        Main loop reading NNJSON (double-newline separated JSON) frames from stdin and X11 ClientMessages.
        """
        sys.stderr.write(f"[libxintent.py] Service '{self.app_id}' listening on stdin and X11 IPC...\n")
        sys.stderr.flush()
        buffer = ""
        stdin_open = True
        x11_fd = self._get_x11_fd()

        while stdin_open or self.x11_client:
            try:
                stdin_open, buffer = self._poll_io_step(stdin_open, buffer, x11_fd)
            except KeyboardInterrupt:
                break
            except Exception as e:
                sys.stderr.write(f"[libxintent.py] Reader error: {e}\n")
                sys.stderr.flush()
                break


__all__ = ["XIntentServer", "XIntentXlibClient"]

if __name__ == "__main__":
    server = XIntentServer("test-service")

    @server.on_intent("ui.TextToSpeech")
    def on_tts(frame):
        return {"status": "ok", "message": "Test TTS output"}

    server.run()
