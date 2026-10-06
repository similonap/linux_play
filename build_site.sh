#!/bin/sh
# Assemble the static GitHub Pages site in ./_site (fslab.py + site/ + xterm vendor files).
#   ./build_site.sh && python3 -m http.server -d _site 8000
set -e
cd "$(dirname "$0")"
rm -rf _site
mkdir -p _site/vendor
cp site/index.html site/webcmds.py fslab.py _site/
cp web/static/vendor/* _site/vendor/
touch _site/.nojekyll
echo "built _site/"
