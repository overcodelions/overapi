#!/bin/sh
# overapi's icons: render the SVGs (scripts/render-icons.cjs), then build the
# macOS .icns from the 1024 px master with the system's own tools.
set -e
cd "$(dirname "$0")/.."
npx electron scripts/render-icons.cjs
set_dir=build/icon.iconset
rm -rf "$set_dir" && mkdir -p "$set_dir"
# 16-32 px from the small cut (heavier strokes), the rest from the master.
pick() { if [ "$1" -le 32 ]; then echo build/icon-small.png; else echo build/icon.png; fi; }
for s in 16 32 128 256 512; do
  sips -z $s $s "$(pick $s)" --out "$set_dir/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$(pick $d)" --out "$set_dir/icon_${s}x${s}@2x.png" >/dev/null
done
rm -f build/icon-small.png
iconutil -c icns "$set_dir" -o build/icon.icns
rm -rf "$set_dir"
echo "build/icon.icns"
