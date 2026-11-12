#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"
LABEL="com.wyih.antigravity-telegram-suite"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs"
OUT_LOG="$LOG_DIR/antigravity-telegram-suite.log"
ERR_LOG="$LOG_DIR/antigravity-telegram-suite.err.log"
UID_NUM="$(id -u)"

load_env_var() {
    local key="$1"
    if [ -f "$ENV_FILE" ]; then
        awk -F= -v k="$key" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
    fi
}

validate_env() {
    if [ ! -f "$ENV_FILE" ]; then
        echo "[error] Missing $ENV_FILE" >&2
        exit 1
    fi
    local token
    token="$(load_env_var BOT_TOKEN)"
    if [ -z "$token" ] || [ "$token" = "your_bot_token_here" ]; then
        echo "[error] Please fill a dedicated Telegram BOT_TOKEN in $ENV_FILE first." >&2
        exit 1
    fi
}

ensure_antigravity_cdp() {
    local app_mode port
    app_mode="$(load_env_var ANTIGRAVITY_PREFERRED_APP)"
    app_mode="${app_mode:-agent}"
    if [ "$app_mode" = "ide" ]; then
        port="$(load_env_var IDE_CDP_PORT)"
        port="${port:-9334}"
        if curl -fsS "http://127.0.0.1:${port}/json" >/dev/null 2>&1; then
            echo "[ok] Antigravity IDE CDP already reachable on 127.0.0.1:${port}"
            return 0
        fi
        echo "[info] Restarting Antigravity IDE with --remote-debugging-port=${port}..."
        osascript -e 'quit app "Antigravity IDE"' >/dev/null 2>&1 || true
        sleep 2
        open -a "Antigravity IDE" --args --remote-debugging-port="${port}"
    else
        port="$(load_env_var AGENT_CDP_PORT)"
        port="${port:-9333}"
        if curl -fsS "http://127.0.0.1:${port}/json" >/dev/null 2>&1; then
            echo "[ok] Antigravity CDP already reachable on 127.0.0.1:${port}"
            return 0
        fi
        echo "[info] Restarting Antigravity with --remote-debugging-port=${port}..."
        osascript -e 'quit app "Antigravity"' >/dev/null 2>&1 || true
        sleep 2
        open -a "Antigravity" --args --remote-debugging-port="${port}"
    fi
}

install_service() {
    validate_env
    local node_bin
    node_bin="$(command -v node || true)"
    if [ -z "$node_bin" ]; then
        echo "[error] node not found in PATH" >&2
        exit 1
    fi
    mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${node_bin}</string>
        <string>${PROJECT_DIR}/src/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$node_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${OUT_LOG}</string>
    <key>StandardErrorPath</key>
    <string>${ERR_LOG}</string>
</dict>
</plist>
EOF
    chmod 600 "$PLIST_PATH"
    launchctl bootout "gui/${UID_NUM}" "$PLIST_PATH" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/${UID_NUM}" "$PLIST_PATH"
    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
    echo "[ok] Installed and started LaunchAgent: ${LABEL}"
    echo "[ok] Logs: ${OUT_LOG}"
}

uninstall_service() {
    launchctl bootout "gui/${UID_NUM}" "$PLIST_PATH" >/dev/null 2>&1 || true
    rm -f "$PLIST_PATH"
    echo "[ok] Uninstalled LaunchAgent: ${LABEL}"
}

restart_service() {
    validate_env
    if [ ! -f "$PLIST_PATH" ]; then
        install_service
        return
    fi
    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}"
    echo "[ok] Restarted LaunchAgent: ${LABEL}"
}

status_service() {
    launchctl print "gui/${UID_NUM}/${LABEL}" 2>&1 | head -n 25 || echo "[info] ${LABEL} is not loaded"
}

case "${1:-status}" in
    install|start)
        install_service
        ;;
    start-all)
        ensure_antigravity_cdp
        install_service
        ;;
    start-antigravity)
        ensure_antigravity_cdp
        ;;
    restart)
        restart_service
        ;;
    uninstall|stop)
        uninstall_service
        ;;
    status)
        status_service
        ;;
    *)
        echo "Usage: $0 {install|start-all|start-antigravity|restart|status|uninstall}" >&2
        exit 1
        ;;
esac
