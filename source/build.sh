#!/bin/bash
set -e
cd "$(dirname "$0")"
mkdir -p site
npx esbuild src/page.js --bundle --platform=browser --format=iife --target=es2020 --minify \
  --inject:src/shim.js --define:global=globalThis --main-fields=browser,module,main \
  --legal-comments=none --outfile=site/lpsign.js --log-level=warning --metafile=build-meta.json
VER=$(sha256sum site/lpsign.js | cut -c1-12)
sed "s/__VER__/$VER/" src/sign.html > site/sign.html
ls -la site
