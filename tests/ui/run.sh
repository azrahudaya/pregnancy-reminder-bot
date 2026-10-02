#!/usr/bin/env bash
# Uji klik panel admin: bangun pratinjau (HTML asli + jaringan dimock) lalu jalankan
# pemeriksaan dengan Chrome sungguhan lewat Playwright.
#
# Jalankan dari akar repo:  bash tests/ui/run.sh
# Butuh: pip install playwright && playwright install chrome (atau Chrome sistem).
set -e
cd "$(dirname "$0")/../.."

node tests/ui/rc-build-preview.js
node tests/ui/rc-build-previews2.js
node tests/ui/rc-build-settings-preview.js

total=0
for skrip in rc-clickthrough.py rc-clickthrough2.py rc-clickthrough3.py rc-clickthrough4.py; do
  echo "--- $skrip"
  python3 "tests/ui/$skrip" | tail -3
  total=$((total + 1))
done
echo "$total berkas uji klik selesai"
