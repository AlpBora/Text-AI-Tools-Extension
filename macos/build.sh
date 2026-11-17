#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="TextAIToolsMac"
OUT_DIR="${1:-$HOME/Applications}"
APP_BUNDLE="$OUT_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

mkdir -p "$MACOS_DIR" "$RES_DIR"

if [ -d "/Applications/Xcode.app/Contents/Developer" ]; then
  export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
fi

echo "Generating AppIcon.icns..."
ICONSET_DIR="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ICONSET_DIR"
BASE_PNG="$ICONSET_DIR/base_1024.png"
if [ -f "$ROOT_DIR/icons/icon1024.png" ]; then
  cp "$ROOT_DIR/icons/icon1024.png" "$BASE_PNG"
else
  swift "$SCRIPT_DIR/make_icon.swift" "$BASE_PNG"
fi
for sz in 16 32 128 256 512; do
  sips -z "$sz" "$sz" "$BASE_PNG" --out "$ICONSET_DIR/icon_${sz}x${sz}.png" >/dev/null
  sz2=$((sz * 2))
  sips -z "$sz2" "$sz2" "$BASE_PNG" --out "$ICONSET_DIR/icon_${sz}x${sz}@2x.png" >/dev/null
done
rm -f "$BASE_PNG"
iconutil -c icns "$ICONSET_DIR" -o "$RES_DIR/AppIcon.icns"
rm -rf "$(dirname "$ICONSET_DIR")"

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
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
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

SIGN_IDENTITY="TextAIToolsMac Local Sign"
if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_IDENTITY"; then
  TMP_CERT_DIR="$(mktemp -d)"
  cat > "$TMP_CERT_DIR/cert.cfg" <<'CERTCFG'
[ req ]
default_bits = 2048
distinguished_name = dn
x509_extensions = v3_codesign
prompt = no

[ dn ]
CN = TextAIToolsMac Local Sign

[ v3_codesign ]
basicConstraints = CA:FALSE
keyUsage = digitalSignature
extendedKeyUsage = codeSigning
CERTCFG
  if openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TMP_CERT_DIR/key.pem" -out "$TMP_CERT_DIR/cert.pem" -days 3650 -config "$TMP_CERT_DIR/cert.cfg" >/dev/null 2>&1; then
    openssl pkcs12 -export -legacy -out "$TMP_CERT_DIR/cert.p12" -inkey "$TMP_CERT_DIR/key.pem" -in "$TMP_CERT_DIR/cert.pem" -passout pass:local >/dev/null 2>&1 \
      || openssl pkcs12 -export -out "$TMP_CERT_DIR/cert.p12" -inkey "$TMP_CERT_DIR/key.pem" -in "$TMP_CERT_DIR/cert.pem" -passout pass:local >/dev/null 2>&1 \
      || true
    if [ -f "$TMP_CERT_DIR/cert.p12" ]; then
      security import "$TMP_CERT_DIR/cert.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P local -T /usr/bin/codesign -A >/dev/null 2>&1 || true
      security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$TMP_CERT_DIR/cert.pem" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$TMP_CERT_DIR"
fi

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_IDENTITY"; then
  codesign --force --deep --sign "$SIGN_IDENTITY" "$APP_BUNDLE" >/dev/null 2>&1 || true
else
  codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null 2>&1 || true
fi
echo "Built: $APP_BUNDLE"
echo "To launch: open \"$APP_BUNDLE\""
