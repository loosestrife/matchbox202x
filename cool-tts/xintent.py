#!/usr/bin/env python3
"""
xintent.py - Python client library for Matchbox / XIntent services.

This library allows Python services (such as cool-tts) to be launched by
matchbox-service-lighter or xintent-router, process incoming intents over
NNJSON (double-newline line-delimited JSON streams), and send back xevents
and response frames.
"""

import sys
import json
import time
import os
from typing import Callable, Dict, Any, Optional


class XIntentServer:
    """
    Matchbox XIntent Service Server.

    Reads NNJSON frames from stdin, dispatches them to registered intent
    handlers, and outputs response frames and xevents to stdout.
    """

    def __init__(self, app_id: str = "cool-tts", toml_path: Optional[str] = None):
        self.app_id = app_id
        self.toml_path = toml_path or self._find_matchbox_toml()
        self.handlers: Dict[str, Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]] = {}

    def _find_matchbox_toml(self) -> Optional[str]:
        candidates = [
            "matchbox.toml",
            os.path.join(os.path.dirname(__file__), "matchbox.toml"),
        ]
        for path in candidates:
            if os.path.exists(path):
                return path
        return None

    def on_intent(self, intent_name: str):
        """Decorator to register a handler function for an intent (e.g. 'ui.TextToSpeech')."""

        def decorator(func: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]):
            self.handlers[intent_name] = func
            return func

        return decorator

    def register_handler(
        self,
        intent_name: str,
        handler: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]],
    ):
        """Registers a handler function for an intent."""
        self.handlers[intent_name] = handler

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
                sys.stderr.write(f"[xintent] Error executing handler for '{intent_name}': {err}\n")
                sys.stderr.flush()
                self.send_event(
                    event_name=f"{intent_name}Error",
                    payload={"message": str(err)},
                    channel=channel,
                    disposition="error",
                    status="error",
                )
        else:
            sys.stderr.write(f"[xintent] No handler registered for intent '{intent_name}' in app '{self.app_id}'\n")
            sys.stderr.flush()

    def run(self):
        """
        Main loop reading NNJSON (double-newline separated JSON) frames from stdin.
        """
        sys.stderr.write(f"[xintent] Service '{self.app_id}' listening on stdin...\n")
        sys.stderr.flush()
        buffer = ""
        while True:
            try:
                chunk = sys.stdin.read(1)
                if not chunk:
                    break
                buffer += chunk
                while "\n\n" in buffer:
                    frame_str, buffer = buffer.split("\n\n", 1)
                    frame_str = frame_str.strip()
                    if frame_str:
                        try:
                            frame = json.loads(frame_str)
                            self.process_frame(frame)
                        except json.JSONDecodeError as e:
                            sys.stderr.write(f"[xintent] Invalid JSON frame: {e} in '{frame_str}'\n")
                            sys.stderr.flush()
            except KeyboardInterrupt:
                break
            except Exception as e:
                sys.stderr.write(f"[xintent] Reader error: {e}\n")
                sys.stderr.flush()
                break


if __name__ == "__main__":
    server = XIntentServer("test-service")

    @server.on_intent("ui.TextToSpeech")
    def on_tts(frame):
        return {"status": "ok", "message": "Test TTS output"}

    server.run()
