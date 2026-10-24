#!/usr/bin/env bash
# Puts the files the web app needs into www/ (icons and the chart library).
set -e
cd "$(dirname "$0")/.."
python3 -c "import PIL" 2>/dev/null || python3 -m pip install --quiet --break-system-packages pillow || python3 -m pip install --quiet pillow
python3 scripts/make_icons.py
mkdir -p www/vendor
if [ ! -f node_modules/lightweight-charts/package.json ]; then npm install --no-audit --no-fund; fi
cp node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js www/vendor/
echo "web files ready"
