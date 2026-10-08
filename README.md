# LP配平机器人 · 手机签名页

静态网页（GitHub Pages），给 Windows 上的「LP配平机器人」签名模式用：机器人到点后发邮件，邮件里的链接打开 `sign.html`，在手机币安钱包里签名。

- 链接格式：`https://hu786793893-hash.github.io/lp-bot/sign.html#v1.<base64url(JSON)>`。任务参数在 `#` 后面，浏览器不会把它发给 GitHub。
- 页面不保存任何东西，没有服务器，拿不到私钥。手续费付款人和仓位所有者都是连接的钱包；钱包地址和链接里的不一致就停止。
- 只为固定池子 Raydium CLMM AAPLx/USDC 0.1%（`ApniVWuZbZoruTAJdyJcLBA4AVw4DKGdV5fHxo6qrAZT`，程序 `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`）构造 撤仓 / 兑换 / 开仓。
- 每一步签名前：检查有效期 → 重新读链（仓位是否还在、是否已经有新仓位、钱包余额、价格偏离、SOL 余额）→ 构造交易 → 安全检查（只允许 ComputeBudget、Raydium CLMM、Token/Token-2022、ATA、System 建账户、Memo；SOL 转账、把代币转给别人、授权、改权限、别的池子一律拒绝）→ 主网模拟 → 显示中文说明 → 钱包签名。
- 源码在 `source/`；`lpsign.js` 是 `source/build.sh` 用 esbuild 打包的结果（含 @raydium-io/raydium-sdk-v2、@solana/web3.js、@solana/spl-token）。
