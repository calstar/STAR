#!/bin/sh
# Builds HiDes Viewer.app and the hides CLI into dist/, with libusb bundled so
# other Macs need no Homebrew. Apple silicon only, because Homebrew's libusb is arm64.
#
# The app is ad-hoc signed, not notarized. On another Mac, clear the download
# quarantine once:  xattr -dr com.apple.quarantine "HiDes Viewer.app"
set -eu
cd "$(dirname "$0")/.."

swift build -c release --product HiDesViewer
swift build -c release --product hides
bin=$(swift build -c release --show-bin-path)
libusb="$(brew --prefix libusb)/lib/libusb-1.0.0.dylib"
version=$(date +%Y.%m.%d)

app="dist/HiDes Viewer.app"
rm -rf dist
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks" "$app/Contents/Resources"
cp "$bin/HiDesViewer" "$app/Contents/MacOS/HiDesViewer"
cp "$libusb" "$app/Contents/Frameworks/"
chmod u+w "$app/Contents/Frameworks/libusb-1.0.0.dylib"
install_name_tool -id @rpath/libusb-1.0.0.dylib "$app/Contents/Frameworks/libusb-1.0.0.dylib"
install_name_tool -change "$(otool -L "$bin/HiDesViewer" | awk '/libusb/ {print $1}')" \
    @rpath/libusb-1.0.0.dylib "$app/Contents/MacOS/HiDesViewer"
install_name_tool -add_rpath @executable_path/../Frameworks "$app/Contents/MacOS/HiDesViewer"

cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>HiDesViewer</string>
    <key>CFBundleIdentifier</key><string>local.hides.viewer</string>
    <key>CFBundleName</key><string>HiDes Viewer</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$version</string>
    <key>CFBundleVersion</key><string>$version</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

# The CLI sits next to the bundled library and finds it through its own rpath.
mkdir -p dist/cli
cp "$bin/hides" dist/cli/hides
cp "$libusb" dist/cli/
chmod u+w dist/cli/libusb-1.0.0.dylib
install_name_tool -id @rpath/libusb-1.0.0.dylib dist/cli/libusb-1.0.0.dylib
install_name_tool -change "$(otool -L "$bin/hides" | awk '/libusb/ {print $1}')" @rpath/libusb-1.0.0.dylib dist/cli/hides
install_name_tool -add_rpath @executable_path dist/cli/hides

codesign --force --sign - "$app/Contents/Frameworks/libusb-1.0.0.dylib"
codesign --force --sign - "$app"
codesign --force --sign - dist/cli/libusb-1.0.0.dylib dist/cli/hides
echo "Built $app and dist/cli/hides"
