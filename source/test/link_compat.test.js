// 机器人生成的链接，签名页能正确解析（两边的编码一致）。需要电脑端源码：LPBOT_SRC=.../lp_bot/src
const assert = require('assert');
const path = require('path'), fs = require('fs');
const SRC = process.env.LPBOT_SRC || path.join(__dirname, '..', '..', '..', 'lp_bot', 'src');
if (!fs.existsSync(path.join(SRC, 'signflow.js'))) { console.log('link compat test skipped (set LPBOT_SRC)'); process.exit(0); }
const SF = require(path.join(SRC, 'signflow'));
const S = require(path.join(SRC, 'strategy'));
const C = require('../core');
const now = Date.now();
const cfg = { ...S.DEFAULTS, rpcUrl: 'https://my-private-rpc.example.com' };
for (const [action, kind, nft] of [['rebalance', 'withdraw', 'EdYT9hoPYNFX4HqyxFccpPxthbivBb3cWK5iKwjMXTNx'], ['open', 'swap', null], ['open', 'open', null], ['withdraw', 'withdraw', 'EdYT9hoPYNFX4HqyxFccpPxthbivBb3cWK5iKwjMXTNx'], ['rebalance', 'open', null], ['flatten', 'withdraw', 'EdYT9hoPYNFX4HqyxFccpPxthbivBb3cWK5iKwjMXTNx'], ['flatten', 'swap', null]]) {
  const task = SF.makeTask({ action, kind, nft, wallet: cfg.walletAddress, summary: '中文摘要', link: { p: 337.1234567, sd: 'sell', su: 12.345, se: now + 3600e3, dv: 2, rf: 336.98712 } }, now, 30);
  const { url, local, isStatic } = SF.taskLink(cfg, 18766, task);
  assert.ok(isStatic && url.startsWith('https://hu786793893-hash.github.io/lp-bot/sign.html#v1.'));
  assert.ok(!/[&+/=]/.test(url.split('#')[1]), 'fragment has no & + / =');
  const raw = C.decodeLink(new URL(url).hash);
  assert.equal(raw.r, undefined, 'bot no longer puts the RPC into the link');
  const p = C.normalizeParams({ ...raw, r: 'https://evil.example.com' });
  assert.equal(p.r, null, 'page ignores an RPC in the link');
  assert.equal(p.id, task.id); assert.equal(p.a, action); assert.equal(p.k, kind); assert.equal(p.n, nft);
  assert.equal(p.w, cfg.walletAddress); assert.equal(p.pl, C.POOL_ID); assert.equal(p.e, Math.floor(task.expires / 1000));
  assert.equal(p.p0, 337.1235); assert.equal(p.su, 12.35); assert.equal(p.sl, 0.5); assert.equal(p.mx, 1000); assert.equal(p.wd, 1);
  assert.equal(p.rf, 336.9871); assert.equal(p.sp, 2);
  assert.equal(C.normalizeParams({ ...raw, dv: undefined }).dv, 2, 'default price-drift tolerance 2%');
  assert.equal(p.ms, cfg.minSolReserve); assert.equal(p.pf, cfg.priorityMicroLamports);
  const steps = { withdraw: { withdraw: ['withdraw'] }, flatten: { withdraw: ['withdraw', 'swap'], swap: ['swap'] }, rebalance: { withdraw: ['withdraw', 'swap', 'open'], open: ['open'] }, open: { swap: ['swap', 'open'], open: ['open'] } };
  assert.deepStrictEqual(C.stepsFor(p), steps[action][kind]);
  assert.equal(local, 'http://127.0.0.1:18766/s/' + task.id);
}
console.log('link compat test passed');
