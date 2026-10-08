#!/bin/bash
# 打包手机签名页：在 source/ 里运行，输出到仓库根目录的 lpsign.js 和 sign.html（GitHub Pages 用的就是这两个文件）。
# 依赖版本由 package-lock.json 锁定（和电脑端机器人同一套），所以同样的源码打出来的 lpsign.js 字节完全一样。
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci --no-audit --no-fund
npx esbuild page.js --bundle --platform=browser --format=iife --target=es2020 --minify \
  --inject:shim.js --define:global=globalThis --main-fields=browser,module,main \
  --legal-comments=none --outfile=../lpsign.js --log-level=warning
VER=$(sha256sum ../lpsign.js | cut -c1-12)
sed "s/__VER__/$VER/" sign.html > ../sign.html
sha256sum ../lpsign.js
