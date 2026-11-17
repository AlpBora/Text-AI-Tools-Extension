#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="TextAIToolsMac"
OUT_DIR="${1:-$HOME/Applications}"
APP_BUNDLE="$OUT_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"

mkdir -p "$MACOS_DIR"

if [ -d "/Applications/Xcode.app/Contents/Developer" ]; then
  export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
fi

echo "Compiling $APP_NAME..."
swiftc -O \
  -framework Cocoa \
  -framework Carbon \
  -framework ApplicationServices \
  "$SCRIPT_DIR/TextAIToolsMac.swift" \
  -o "$MACOS_DIR/$APP_NAME"

cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>com.alpbora.TextAIToolsMac</string>
  <key>CFBundleName</key>
  <string>Text AI Tools</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.7.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>TextAIToolsRootDir</key>
  <string>$ROOT_DIR</string>
</dict>
</plist>
EOF

codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null 2>&1 || true
echo "Built: $APP_BUNDLE"
echo "To launch: open \"$APP_BUNDLE\""
