#!/usr/bin/env bash
# Rebuilds claude-app/zips/ after a skill folder changes; the app wants the folder itself at the zip root.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p zips
for d in */; do
  d=${d%/}
  [ "$d" = zips ] && continue
  rm -f "zips/$d.zip"
  zip -qrX "zips/$d.zip" "$d" -x '*/__pycache__/*' '*.pyc'
done
ls -l zips
