#!/usr/bin/env bash
# XIntent XDG Desktop Portal Installation Script

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PORTAL_DIR="${HOME}/.local/share/xdg-desktop-portal/portals"
CONFIG_DIR="${HOME}/.config/xdg-desktop-portal"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"

echo "=== Installing XIntent XDG Desktop Portal Bridge ==="

# Make python daemon executable
chmod +x "${SCRIPT_DIR}/xintent-portal-daemon.py"

# Create required directories
mkdir -p "${PORTAL_DIR}"
mkdir -p "${CONFIG_DIR}"
mkdir -p "${SYSTEMD_USER_DIR}"

# Copy .portal configuration
cp "${SCRIPT_DIR}/portals/xintent.portal" "${PORTAL_DIR}/"
echo "[+] Installed portal config to: ${PORTAL_DIR}/xintent.portal"

# Copy systemd user service
cp "${SCRIPT_DIR}/xdg-portal-bridge.service" "${SYSTEMD_USER_DIR}/"
echo "[+] Installed systemd user service to: ${SYSTEMD_USER_DIR}/xdg-portal-bridge.service"

# Configure portals.conf if missing
if [ ! -f "${CONFIG_DIR}/portals.conf" ]; then
    cp "${SCRIPT_DIR}/portals.conf" "${CONFIG_DIR}/portals.conf"
    echo "[+] Created default portals configuration at: ${CONFIG_DIR}/portals.conf"
else
    echo "[!] Existing ${CONFIG_DIR}/portals.conf found."
    echo "    To make XIntent your default file picker, add the following line under [Preferred]:"
    echo "    org.freedesktop.impl.portal.FileChooser=xintent"
fi

echo ""
echo "=== Installation Complete ==="
echo "1. cool-service-lighter: Auto-loads 'xdg-portal-bridge' alongside 'cool-http-bridge'."
echo "2. systemd (optional): systemctl --user daemon-reload && systemctl --user enable --now xdg-portal-bridge"
echo "3. Firefox: Launch with GTK_USE_PORTAL=1 firefox"
