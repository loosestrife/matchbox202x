#!/usr/bin/env python3
# /// script
# dependencies = [
#     "python-xlib>=0.33",
# ]
# ///
"""
DLNA to XIntent Bridge Daemon
=============================
Main entry point orchestrating XIntent/XBlob IPC and DLNA Media Management over the X11 Bus.
All communication between cool-http-bridge, xbus-daemon, and dlna-bridge occurs natively over
the shared X11 IPC bus.
"""

import argparse
import asyncio
import logging
import os
from typing import Optional, Tuple

from dlna_media_manager import DLNADevice, DLNAMediaManager
from xintent_bridge import X11DeviceManager, ensure_readable_fd

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S"
)
logger = logging.getLogger("dlna_xintent_bridge")


def _is_syn_channel_request(payload: dict) -> Tuple[int, int, int, bool]:
    tx_id = payload.get("txId") or payload.get("id") or 0
    sender_win = payload.get("sender") or 0
    channel_id = payload.get("channel") or 0
    control_word_in = payload.get("controlWord") or payload.get("control_word") or 0
    is_syn = (control_word_in == 1) or (channel_id != 0 and control_word_in != 2)
    return tx_id, sender_win, channel_id, is_syn


def _send_fin_response_if_needed(dev: DLNADevice, event_name: str, tx_id: int, sender_win: int, channel_id: int, is_syn: bool) -> None:
    if not is_syn or not dev.xintent_client:
        return
    try:
        res_event = {
            "event": event_name,
            "txId": tx_id,
            "app": dev.app_id,
            "status": "ok"
        }
        dev.xintent_client.send_event(
            target_win_id=sender_win or dev.xintent_client.get_router_win_id(),
            payload=res_event,
            tx_id=tx_id,
            channel=channel_id,
            control_word=2,
            sender_win_id=dev.xintent_win_id
        )
        logger.info(f"Sent {event_name} with controlWord: FIN (2) on channel {channel_id} from window {hex(dev.xintent_win_id)}")
    except Exception as ex_resp:
        logger.debug(f"Error sending FIN response for {event_name}: {ex_resp}")


def _unlink_incoming_blob(dev: DLNADevice, data_blob_id: Optional[int], was_transcoded: bool) -> None:
    if was_transcoded or not data_blob_id or not dev.xintent_client or not hasattr(dev.xintent_client, "blob_unlink"):
        return
    try:
        dev.xintent_client.blob_unlink(data_blob_id, win_id=dev.xintent_win_id)
        logger.info(f"Unlinked incoming XBlob {hex(data_blob_id)} after intent handling completed")
    except Exception as ex_u:
        logger.debug(f"XBlobUnlink error for blob {hex(data_blob_id)}: {ex_u}")


def _extract_send_to_raw_blob(dev: DLNADevice, payload: dict, data_blob_id: Optional[int], name: str) -> Optional[dict]:
    if data_blob_id and dev.xintent_client and hasattr(dev.xintent_client, "blob_read"):
        try:
            raw_blob = dev.xintent_client.blob_read(data_blob_id)
            logger.info(f"Read XBlob {hex(data_blob_id)} for fs.SendTo")
            if raw_blob:
                return raw_blob
        except Exception as ex:
            logger.error(f"Error reading XBlob {data_blob_id} for fs.SendTo: {ex}")

    blob = payload.get("payload") or payload.get("blob") or {}
    if isinstance(blob, dict) and blob:
        return blob
    if payload.get("data"):
        return {"data": payload.get("data"), "type": payload.get("mimeType"), "name": name}
    return None


class DLNAXIntentBridgeDaemon:
    def __init__(self, server_ws_url: str = "ws://localhost:12355/xaudio", ssdp_interval: int = 30, display_name: Optional[str] = None, http_port: int = 8089, mock_device: bool = False):
        self.server_ws_url = server_ws_url
        self.ssdp_interval = ssdp_interval
        self.http_port = http_port
        self.mock_device = mock_device or (os.environ.get("MOCK_DLNA_DEVICE") == "1")
        self.media_mgr = DLNAMediaManager(http_port=http_port, server_ws_url=server_ws_url, mock_device=self.mock_device)
        self.x11_mgr = X11DeviceManager(display_name=display_name)
        self.main_x11_client = None
        self.running = False

    def register_main_bridge_x11_window(self):
        if not self.x11_mgr.enabled or not self.x11_mgr.main_client:
            return
        try:
            manifest = (
                '[app]\n'
                'id = "dlna-bridge"\n'
                'name = "DLNA/UPnP Device Bridge"\n'
                '\n'
                '[intents]\n'
                '"media.FindDevices" = true\n'
                '"bridge.Advertise" = true\n'
            )
            win_id = self.x11_mgr.main_client.client_win.id
            matchbox_atom = self.x11_mgr.main_client.atoms["MATCHBOX_TOML"]
            string_atom = self.x11_mgr.main_client.atoms["STRING"]
            self.x11_mgr.main_client.x11.set_window_property_string(
                win_id,
                matchbox_atom,
                manifest,
                type_atom=string_atom
            )

            def main_handler(payload):
                intent = payload.get("intent") or "media.FindDevices"
                if intent == "media.FindDevices":
                    loop = asyncio.get_event_loop()
                    asyncio.run_coroutine_threadsafe(self.handle_find_devices_intent(payload), loop)

            self.x11_mgr.main_client.register_handler("media.FindDevices", main_handler, win_id=win_id)
            logger.info(f"Registered main dlna-bridge manifest on shared X11 Window {hex(win_id)} for media.FindDevices")
        except Exception as e:
            logger.error(f"Failed to register main dlna-bridge X11 manifest: {e}")

    def advertise_device(self, dev: DLNADevice):
        if self.x11_mgr.enabled:
            self.x11_mgr.attach_device_x11_window(dev, self.on_x11_device_intent)

    def _log_coro_exception(self, fut, name: str):
        try:
            exc = fut.exception()
            if exc:
                logger.error(f"Unhandled exception in coroutine '{name}': {exc}", exc_info=exc)
        except Exception as e:
            logger.error(f"Error checking coroutine exception for '{name}': {e}", exc_info=True)

    def on_x11_device_intent(self, app_id: str, payload: dict):
        loop = asyncio.get_event_loop()
        intent = payload.get("intent") or "fs.SendTo"
        logger.info(f"on_x11_device_intent received for app '{app_id}': intent='{intent}', payload_keys={list(payload.keys())}")
        if intent == "fs.SendTo":
            fut = asyncio.run_coroutine_threadsafe(self.handle_send_to_intent(app_id, payload), loop)
            fut.add_done_callback(lambda f: self._log_coro_exception(f, "handle_send_to_intent"))
        elif intent == "media.Play":
            fut = asyncio.run_coroutine_threadsafe(self.handle_play_intent(app_id, payload), loop)
            fut.add_done_callback(lambda f: self._log_coro_exception(f, "handle_play_intent"))

    async def handle_send_to_intent(self, app_id: str, payload: dict):
        dev = self.media_mgr.devices.get(app_id)
        data_blob_id = payload.get("dataBlob") or payload.get("data_blob")
        logger.info(f"handle_send_to_intent START for app_id '{app_id}' (device: '{dev.friendly_name if dev else 'NOT FOUND'}', dataBlob: {hex(data_blob_id) if data_blob_id else 'None'})")
        if not dev:
            logger.error(f"Device for app '{app_id}' NOT FOUND in media_mgr.devices! Registered devices: {list(self.media_mgr.devices.keys())}")
            return

        tx_id, sender_win, channel_id, is_syn = _is_syn_channel_request(payload)
        blob = payload.get("payload") or payload.get("blob") or {}
        name = payload.get("name") or (blob.get("name") if isinstance(blob, dict) else "Sent Media")

        raw_blob = _extract_send_to_raw_blob(dev, payload, data_blob_id, name)
        _send_fin_response_if_needed(dev, "fs.SendToResponseV0", tx_id, sender_win, channel_id, is_syn)

        if not raw_blob:
            logger.error(f"Received fs.SendTo for {dev.friendly_name} with no usable payload data")
            return

        try:
            logger.info("handle_send_to_intent: Resolving raw_blob via ensure_readable_fd()...")
            fd, mime_type, file_name = ensure_readable_fd(raw_blob)
            if name and name != "media_payload":
                file_name = name

            logger.info(f"handle_send_to_intent: Resolved readable fd {fd} ('{file_name}', {mime_type}) for '{dev.friendly_name}'. Calling play_media()...")
            was_transcoded = False
            try:
                was_transcoded = await self.media_mgr.play_media(app_id, fd, mime_type, file_name, tx_id=tx_id, x11_client=dev.xintent_client, data_blob_id=data_blob_id)
                logger.info(f"handle_send_to_intent: play_media completed for '{dev.friendly_name}' (was_transcoded: {was_transcoded})")
            finally:
                _unlink_incoming_blob(dev, data_blob_id, bool(was_transcoded))
        except Exception as ex_st:
            logger.error(f"Unhandled error in handle_send_to_intent for '{dev.friendly_name}': {ex_st}", exc_info=True)

    async def _play_from_xblob(self, app_id: str, dev: DLNADevice, data_blob_id: int, title: str, tx_id: int, sender_win: int, channel_id: int, is_syn: bool) -> bool:
        if not dev.xintent_client or not hasattr(dev.xintent_client, "blob_read"):
            return False
        try:
            raw_blob = dev.xintent_client.blob_read(data_blob_id)
            _send_fin_response_if_needed(dev, "media.PlayResponseV0", tx_id, sender_win, channel_id, is_syn)
            if not raw_blob:
                return False
            fd, mime_type, _ = ensure_readable_fd(raw_blob)
            was_transcoded = False
            try:
                was_transcoded = await self.media_mgr.play_media(app_id, fd, mime_type, title, tx_id=tx_id, x11_client=dev.xintent_client, data_blob_id=data_blob_id)
            finally:
                _unlink_incoming_blob(dev, data_blob_id, bool(was_transcoded))
            return True
        except Exception as ex:
            logger.error(f"Error reading XBlob {data_blob_id} for media.Play: {ex}")
            return False

    async def handle_play_intent(self, app_id: str, payload: dict):
        dev = self.media_mgr.devices.get(app_id)
        if not dev:
            logger.error(f"Device for app {app_id} not found")
            return

        tx_id, sender_win, channel_id, is_syn = _is_syn_channel_request(payload)
        media_url = payload.get("url") or payload.get("uri") or payload.get("data")
        mime_type = payload.get("mimeType") or "video/mp4"
        title = payload.get("title") or "XIntent Media Stream"
        data_blob_id = payload.get("dataBlob") or payload.get("data_blob")

        if not media_url and data_blob_id:
            if await self._play_from_xblob(app_id, dev, data_blob_id, title, tx_id, sender_win, channel_id, is_syn):
                return

        blob = payload.get("blob")
        if not media_url and blob:
            raw_blob = blob if isinstance(blob, dict) else {"data": blob}
            fd, mime_type, _ = ensure_readable_fd(raw_blob)
            await self.media_mgr.play_media(app_id, fd, mime_type, title, tx_id=tx_id, x11_client=dev.xintent_client)
            return

        if not media_url:
            logger.error(f"Received media.Play intent for {dev.friendly_name} with no media URL")
            return

        await self.media_mgr.play_media(app_id, media_url, mime_type, title, tx_id=tx_id, x11_client=dev.xintent_client)

    async def handle_find_devices_intent(self, payload: dict) -> dict:
        tx_id = payload.get("txId") or payload.get("id") or 0
        logger.info("Received media.FindDevices intent. Initiating network SSDP scan...")

        await self.media_mgr.scan_ssdp_now(duration_sec=3.0, on_discovered=self.advertise_device)

        device_list = [
            {
                "appId": dev.app_id,
                "name": dev.friendly_name,
                "accept": dev.accept_header_val,
                "location": dev.location,
                "manufacturer": dev.manufacturer,
                "modelName": dev.model_name
            }
            for dev in self.media_mgr.devices.values()
        ]
        return {
            "event": "media.FindDevicesResponseV0",
            "txId": tx_id,
            "status": "ok",
            "devices": device_list
        }

    async def run(self):
        self.running = True
        self.register_main_bridge_x11_window()
        self.x11_mgr.start_event_loop()

        if self.mock_device:
            dev = self.media_mgr.register_mock_device()
            self.advertise_device(dev)
        else:
            asyncio.create_task(self.media_mgr.scan_ssdp_now(duration_sec=3.0, on_discovered=self.advertise_device))

        media_server = await asyncio.start_server(self.media_mgr.handle_http_media_request, "0.0.0.0", self.http_port)
        logger.info(f"DLNA Media Host HTTP Server running on http://{self.media_mgr.local_ip}:{self.http_port}")

        async with media_server:
            await media_server.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="DLNA to XIntent Bridge Daemon")
    parser.add_argument("--port", type=int, default=8089, help="HTTP server port for hosting DLNA media files")
    parser.add_argument("--server", type=str, default="ws://localhost:12355/xaudio", help="XIntent WebSocket server URL")
    parser.add_argument("--ssdp-interval", type=int, default=30, help="SSDP discovery scan interval in seconds")
    parser.add_argument("--display", type=str, default=None, help="X11 DISPLAY (e.g. :0)")
    parser.add_argument("--mock-device", action="store_true", help="Register a mock DLNA device for testing")

    args = parser.parse_args()

    daemon = DLNAXIntentBridgeDaemon(
        server_ws_url=args.server,
        ssdp_interval=args.ssdp_interval,
        display_name=args.display,
        http_port=args.port,
        mock_device=args.mock_device
    )

    try:
        asyncio.run(daemon.run())
    except KeyboardInterrupt:
        logger.info("Stopping DLNA XIntent Bridge...")


if __name__ == "__main__":
    main()
