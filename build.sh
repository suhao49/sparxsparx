#!/usr/bin/env sh
# Packages the extension into sparx-bookwork-logger.xpi (a zip file).
set -e
cd "$(dirname "$0")/extension"
rm -f ../sparx-bookwork-logger.xpi
zip -r -X ../sparx-bookwork-logger.xpi manifest.json content.js popup.html popup.js icon.svg
echo "Built $(cd .. && pwd)/sparx-bookwork-logger.xpi"
