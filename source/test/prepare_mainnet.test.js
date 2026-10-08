// 兑换/开仓前的新检查（只读主网，不签名不发送）：止损线、缺参考价、已有仓位、RPC 伪造金库地址。
const assert = require('assert');
const C = require('../core');
const H79 = process.env.WALLET_WITH_POSITION || 'H79nMh1MyzUxEhp2TXuQWh9eDFZ9gnMhkPgMkg4vLfm5';
const EMPTY = process.env.WALLET_NO_POSITION || 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS';
(async () => {
  const conn = C.makeConnection({});
  const pool = await C.readPool(conn);
  const now = Math.floor(Date.now() / 1000);
  const base = { id: 'testtask_abcdefgh', c: now - 60, e: now + 1800, pl: C.POOL_ID, p: pool.P, wd: 1, mx: 200, sl: 0.5, dv: 3, pf: 100000, ms: 0.01, sp: 2, a: 'open' };
  const P = q => C.normalizeParams(q);
  const wE = await C.readWallet(conn, EMPTY, pool);
  if (wE.positions.length) { console.log('skip: test wallet now has positions'); return; }
  // 1) 价格已在止损线下（参考价设得比现价高 3%）→ 拒绝兑换/开仓
  let r = await C.prepareStep(conn, P({ ...base, w: EMPTY, k: 'open', rf: pool.P * 1.03 }), 'open');
  assert.equal(r.status, 'refuse'); assert.ok(/止损线/.test(r.reason), r.reason); console.log('  拒绝 ✓ 止损线下不开仓');
  r = await C.prepareStep(conn, P({ ...base, w: EMPTY, k: 'swap', rf: pool.P * 1.03, su: 50 }), 'swap');
  assert.equal(r.status, 'refuse'); assert.ok(/止损线/.test(r.reason)); console.log('  拒绝 ✓ 止损线下不兑换');
  // 2) 链接里没有参考价 → 拒绝
  r = await C.prepareStep(conn, P({ ...base, w: EMPTY, k: 'open' }), 'open');
  assert.equal(r.status, 'refuse'); assert.ok(/参考价/.test(r.reason)); console.log('  拒绝 ✓ 缺参考价');
  // 3) 参考价正常（现价在止损线上方）→ 照常构造开仓
  r = await C.prepareStep(conn, P({ ...base, w: EMPTY, k: 'open', rf: pool.P * 1.01 }), 'open');
  assert.equal(r.status, 'build', r.reason); const sim = await C.simulate(conn, r.built.tx); assert.equal(sim.err, null); console.log('  通过 ✓ 正常开仓，模拟成功', sim.units, 'CU');
  // 4) 钱包里已经有这个池子的仓位 → 不再开仓
  const wH = await C.readWallet(conn, H79, pool);
  if (wH.positions.length) {
    r = await C.prepareStep(conn, P({ ...base, w: H79, k: 'open', rf: pool.P }), 'open');
    assert.equal(r.status, 'refuse'); assert.ok(/已经有/.test(r.reason), r.reason); console.log('  拒绝 ✓ 已有仓位不再开仓');
  }
  // 5) RPC 返回的池子金库地址被改 → 拒绝
  const { PoolInfoLayout } = require('@raydium-io/raydium-sdk-v2');
  const off = PoolInfoLayout.offsetOf('vaultA');
  const fake = Object.create(conn);
  fake.getAccountInfo = async (k, c) => { const i = await conn.getAccountInfo(k, c); if (k.toBase58() !== C.POOL_ID) return i; const d = Buffer.from(i.data); d.fill(7, off, off + 32); return { ...i, data: d }; };
  await assert.rejects(() => C.readPool(fake), /金库地址不对/); console.log('  拒绝 ✓ 伪造金库地址');
  console.log('prepare mainnet test passed');
})().catch(e => { console.error(e); process.exit(1); });
