#!/bin/sh
# Builds HiDes Viewer.app and the hides CLI into dist/, with libusb bundled so
# other Macs need no Homebrew. Apple silicon only, because Homebrew's libusb is arm64.
#
# The app is ad-hoc signed, not notarized. On another Mac, clear the download
# quarantine once:  xattr -dr com.apple.quarantine "HiDes Viewer.app"
#
#   sh scripts/make-app.sh             build into dist/
#   sh scripts/make-app.sh --install   build, copy to /Applications (~/Applications if
#                                      that is not writable), and keep it in the Dock
set -eu
cd "$(dirname "$0")/.."

install=0
for a in "$@"; do
  case "$a" in
    --install) install=1 ;;
    *) echo "unknown option $a" >&2; exit 2 ;;
  esac
done

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

[ "$install" = 1 ] || exit 0

# Like any other app: in Applications, launched from the Dock, found by Spotlight.
dest=/Applications
[ -w "$dest" ] || { dest="$HOME/Applications"; mkdir -p "$dest"; }
osascript -e 'quit app "HiDes Viewer"' >/dev/null 2>&1 || true
rm -rf "$dest/HiDes Viewer.app"
cp -R "$app" "$dest/"
echo "Installed $dest/HiDes Viewer.app"

# Pin it once; a re-install keeps the Dock as the operator arranged it.
if defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q 'HiDes%20Viewer.app'; then
  echo "Already in the Dock"
else
  defaults write com.apple.dock persistent-apps -array-add \
    "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file://$(printf %s "$dest" | sed 's/ /%20/g')/HiDes%20Viewer.app/</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
  killall Dock
  echo "Added to the Dock"
fi
