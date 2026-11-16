#!/bin/sh
# Starts Unchore at login and keeps it running (macOS LaunchAgent).
#   ./scripts/install-launchd.sh            install / update
#   ./scripts/install-launchd.sh uninstall  remove
set -e
LABEL=com.unchore.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$1" = "uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

cd "$DIR"
npm run build >/dev/null
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/unchore"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string><string>exec npx tsx server/index.ts</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/unchore/server.log</string>
  <key>StandardErrorPath</key><string>$HOME/unchore/server.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Unchore will now run at login: http://localhost:${PORT:-4477} (logs: ~/unchore/server.log)"
