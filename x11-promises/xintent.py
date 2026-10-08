#!/usr/bin/env python3
"""
xintent.py - Python client library for Matchbox / XIntent services.

Provides both:
1. XIntentServer: Dual-mode server (NNJSON stdin/stdout pipe mode AND X11 IPC window mode).
2. XIntentXlibClient: Native X11 IPC mode using python-xlib (mirroring xintent.js).
"""

import sys
import json
import time
import os
import select
import logging
from typing import Callable, Dict, Any, Optional

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


class XIntentServer:
    """
    Matchbox XIntent Service Server.

    Handles incoming intents over both stdin NNJSON frames and native X11 window IPC events,
    dispatching them to registered intent handlers.
    """

    def __init__(self, app_id: str = "cool-tts", toml_path: Optional[str] = None):
        self.app_id = app_id
        self.toml_path = toml_path or self._find_matchbox_toml()
        self.handlers: Dict[str, Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]] = {}
        self.x11_client = None

        self._try_register_x11_window()

    def _find_matchbox_toml(self) -> Optional[str]:
        candidates = [
            "matchbox.toml",
            os.path.join(os.path.dirname(__file__), "matchbox.toml"),
            os.path.join(os.path.dirname(__file__), "../cool-tts/matchbox.toml"),
        ]
        for path in candidates:
            if os.path.exists(path):
                return path
        return None

    def _try_register_x11_window(self):
        if not os.environ.get("DISPLAY"):
            return
        try:
            x11_path = os.path.abspath(os.path.dirname(__file__))
            if x11_path not in sys.path:
                sys.path.insert(0, x11_path)

            from xintent_xlib import XIntentXlibClient
            if XIntentXlibClient:
                self.x11_client = XIntentXlibClient(app_id=self.app_id)
                if self.toml_path and os.path.exists(self.toml_path):
                    with open(self.toml_path, "r", encoding="utf-8") as f:
                        toml_content = f.read()
                    self.x11_client.register_matchbox_toml(toml_content)
                    sys.stderr.write(f"[libxintent.py] Registered MATCHBOX_TOML on X11 window {hex(self.x11_client.client_win.id)} for '{self.app_id}'\n")
                    sys.stderr.flush()
        except Exception as e:
            sys.stderr.write(f"[libxintent.py] Could not register X11 MATCHBOX_TOML: {e}\n")
            sys.stderr.flush()

    def on_intent(self, intent_name: str):
        """Decorator to register a handler function for an intent (e.g. 'ui.TextToSpeech')."""

        def decorator(func: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]):
            self.register_handler(intent_name, func)
            return func

        return decorator

    def register_handler(
        self,
        intent_name: str,
        handler: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]],
    ):
        """Registers a handler function for an intent."""
        self.handlers[intent_name] = handler
        if self.x11_client:
            self.x11_client.on_intent(intent_name)(handler)

    def send_event(
        self,
        event_name: str,
        payload: Optional[Any] = None,
        channel: Optional[Any] = None,
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

        for k, v in extra.items():
            response_frame[k] = v

        output_str = json.dumps(response_frame) + "\n\n"
        sys.stdout.write(output_str)
        sys.stdout.flush()

    def process_frame(self, frame: Dict[str, Any]):
        """Processes a single parsed JSON frame received from stdin."""
        intent_name = (
            frame.get("intent")
            or frame.get("action")
            or (
                frame.get("payload", {}).get("intent")
                if isinstance(frame.get("payload"), dict)
                else None
            )
            or (
                frame.get("payload", {}).get("action")
                if isinstance(frame.get("payload"), dict)
                else None
            )
        )

        if not intent_name:
            return

        channel = frame.get("channel")

        if intent_name in self.handlers:
            handler = self.handlers[intent_name]
            try:
                result = handler(frame)
                if result is not None:
                    response_intent = f"{intent_name}Response"
                    if isinstance(result, dict):
                        disp = result.pop("disposition", "final")
                        evt = result.pop("event", result.pop("intent", response_intent))
                        res_status = result.pop("status", "ok")
                        self.send_event(
                            event_name=evt,
                            payload=result,
                            channel=channel,
                            disposition=disp,
                            status=res_status,
                        )
                    else:
                        self.send_event(
                            event_name=response_intent,
                            payload={"data": result},
                            channel=channel,
                            disposition="final",
                        )
            except Exception as err:
                logger.error(f"[libxintent.py] Error executing handler for '{intent_name}': {err}", exc_info=True)
                self.send_event(
                    event_name=f"{intent_name}Error",
                    payload={"message": str(err)},
                    channel=channel,
                    disposition="error",
                    status="error",
                )
        else:
            logger.warning(f"[libxintent.py] No handler registered for intent '{intent_name}' in app '{self.app_id}'")

    def run(self):
        """
        Main loop reading NNJSON (double-newline separated JSON) frames from stdin and X11 ClientMessages.
        """
        sys.stderr.write(f"[libxintent.py] Service '{self.app_id}' listening on stdin and X11 IPC...\n")
        sys.stderr.flush()
        buffer = ""
        stdin_open = True

        x11_fd = None
        try:
            if self.x11_client and hasattr(self.x11_client, 'x11') and hasattr(self.x11_client.x11, 'disp'):
                x11_fd = self.x11_client.x11.disp.display.socket.fileno()
        except Exception:
            x11_fd = None

        while True:
            try:
                if self.x11_client:
                    self.x11_client.process_events_once()

                rfds = []
                if stdin_open:
                    rfds.append(sys.stdin)
                if x11_fd is not None:
                    rfds.append(x11_fd)

                if rfds:
                    r, _, _ = select.select(rfds, [], [], 0.05)
                    if sys.stdin in r:
                        chunk = sys.stdin.read(1)
                        if not chunk:
                            stdin_open = False
                        else:
                            buffer += chunk
                            while "\n\n" in buffer:
                                frame_str, buffer = buffer.split("\n\n", 1)
                                frame_str = frame_str.strip()
                                if frame_str:
                                    try:
                                        frame = json.loads(frame_str)
                                        self.process_frame(frame)
                                    except json.JSONDecodeError as e:
                                        sys.stderr.write(f"[libxintent.py] Invalid JSON frame: {e} in '{frame_str}'\n")
                                        sys.stderr.flush()

                    if x11_fd is not None and x11_fd in r:
                        if self.x11_client:
                            self.x11_client.process_events_once()
                else:
                    time.sleep(0.05)

                if not stdin_open and not self.x11_client:
                    break
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
