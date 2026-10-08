'use strict';
// LP配平签名页核心逻辑（浏览器和 Node 测试共用）。
// 只为固定的 Raydium CLMM AAPLx/USDC 池子构造 撤仓 / 兑换 / 开仓 交易，钱包只需要公钥。
const { Connection, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const { Raydium, TxVersion, PoolUtils, PoolInfoLayout, PersonalPositionLayout, getPdaPersonalPositionAddress } = require('@raydium-io/raydium-sdk-v2');
const BN = require('bn.js');

const POOL_ID = 'ApniVWuZbZoruTAJdyJcLBA4AVw4DKGdV5fHxo6qrAZT';
const CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const MINT_A = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp'; // AAPLx (Token-2022)
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
// 池子的两个金库地址在池子创建时就固定了：写死，不信任 RPC 返回的
const VAULT_A = '69u6oEwRayMozqCWF9Vny6qiYN5f18pZVUtboaDJkXuj';
const VAULT_B = '3zBLzabogNNQ4s2zcuioXncdbTPED4jPx1x2J3Jn8Ezt';
const MAX_RENT_LAMPORTS = 20000000; // 新建账户最多押 0.02 SOL（代币账户/NFT 账户租金远低于这个）
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
const CB = 'ComputeBudget111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const ALLOWED_PROGRAMS = [CB, CLMM, TOKEN, TOKEN22, ATA, SYSTEM, MEMO];
const TK = 'AAPLx（苹果）';
const CU_LIMIT = 600000;

// Anchor 指令前 8 字节
const DISC = {
  decrease_liquidity_v2: '3a7fbc3e4f52c460', decrease_liquidity: 'a026d06f685b2c01', close_position: '7b86510031446262',
  swap_v2: '2b04ed0b1ac91e62', swap: 'f8c69e91e17587c8',
  open_position_with_token22_nft: '4dffae527d1dc92e', open_position_v2: '4db84ad67056f1c7',
};
const DISC_NAME = Object.fromEntries(Object.entries(DISC).map(([k, v]) => [v, k]));

// ---------------- 链接参数 ----------------
const b64uEnc = s => {
  const bytes = new TextEncoder().encode(s); let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64uDec = s => {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u);
};
function encodeLink(obj) { return 'v1.' + b64uEnc(JSON.stringify(obj)); }
function decodeLink(fragment) {
  let f = String(fragment || '').replace(/^#/, '').trim();
  if (!f) throw new Error('链接不完整：缺少任务参数');
  if (!f.startsWith('v1.')) throw new Error('链接格式不认识');
  let o; try { o = JSON.parse(b64uDec(f.slice(3))); } catch (_) { throw new Error('链接参数损坏'); }
  return o;
}
const isAddr = s => { try { return typeof s === 'string' && new PublicKey(s).toBase58() === s; } catch (_) { return false; } };
const num = (v, d) => (v === undefined || v === null || v === '' || !isFinite(Number(v)) ? d : Number(v));

/** 校验并补默认值。抛出中文错误。 */
function normalizeParams(o) {
  if (!o || typeof o !== 'object') throw new Error('链接参数损坏');
  const p = {
    id: String(o.id || ''), a: o.a, k: o.k || null, n: o.n || null, w: o.w,
    c: num(o.c, 0), e: num(o.e, 0), pl: o.pl || POOL_ID,
    p0: num(o.p, 0), wd: num(o.wd, 1), mx: num(o.mx, 1000), sl: num(o.sl, 0.5), dv: num(o.dv, 2),
    pf: num(o.pf, 100000), ms: num(o.ms, 0.05), sd: o.sd || null, su: num(o.su, 0), se: num(o.se, 0),
    rf: num(o.rf, 0), sp: num(o.sp, 2),
    // 链接没有签名，任何人都能改 # 后面的内容：不再使用链接里的 RPC 地址，只用本页内置的节点
    r: null,
  };
  if (!/^[\w-]{8,80}$/.test(p.id)) throw new Error('链接缺少任务编号');
  if (!['withdraw', 'rebalance', 'open'].includes(p.a)) throw new Error('链接里的操作类型不认识');
  if (p.k && !['withdraw', 'swap', 'open'].includes(p.k)) throw new Error('链接里的步骤不认识');
  if (!isAddr(p.w)) throw new Error('链接里的钱包地址不正确');
  if (p.pl !== POOL_ID) throw new Error('链接里的池子不是 AAPLx/USDC 池子，已拒绝');
  if ((p.a === 'withdraw' || p.a === 'rebalance') && (p.k || 'withdraw') === 'withdraw' && !isAddr(p.n)) throw new Error('链接缺少要撤的仓位编号');
  if (p.n && !isAddr(p.n)) throw new Error('仓位编号不正确');
  if (!(p.e > 0 && p.c > 0 && p.e > p.c)) throw new Error('链接缺少有效期');
  if (!(p.wd > 0 && p.wd < 50)) throw new Error('区间宽度参数不正确');
  if (!(p.sl > 0 && p.sl <= 5)) throw new Error('滑点参数应在 0–5%');
  if (!(p.mx > 0)) throw new Error('单次最大金额参数不正确');
  if (!(p.dv > 0 && p.dv <= 20)) p.dv = 2;
  if (!(p.pf >= 0 && p.pf <= 5e6)) p.pf = 100000;
  if (!(p.ms >= 0 && p.ms < 10)) p.ms = 0.05;
  if (!(p.sp > 0 && p.sp < 50)) p.sp = 2;
  if (!(p.rf > 0)) p.rf = 0;
  return p;
}

/** 这个链接要做的步骤（按顺序）。 */
function stepsFor(p) {
  const all = p.a === 'withdraw' ? ['withdraw'] : p.a === 'rebalance' ? ['withdraw', 'swap', 'open'] : ['swap', 'open'];
  const first = p.k || all[0];
  const i = all.indexOf(first);
  return i < 0 ? all : all.slice(i);
}

// ---------------- RPC（按方法分流 + 故障切换） ----------------
const RPC_PLAIN = ['https://solana-rpc.publicnode.com', 'https://public.rpc.solanavibestation.com', 'https://rpc.solanatracker.io/public'];
const RPC_INDEXED = ['https://public.rpc.solanavibestation.com', 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
const INDEXED = new Set(['getTokenAccountsByOwner', 'getParsedTokenAccountsByOwner', 'getProgramAccounts', 'getTokenLargestAccounts']);
const NO_RETRY = new Set(['sendTransaction']);

function makeFetch(opts = {}) {
  const baseFetch = opts.fetch || ((...a) => fetch(...a));
  const log = opts.log || (() => { });
  const extra = opts.rpcUrl ? [opts.rpcUrl] : [];
  const plain = [...extra, ...(opts.rpcPlain || RPC_PLAIN)], indexed = [...extra, ...(opts.rpcIndexed || RPC_INDEXED)];
  const cache = new Map(); // 同样的索引查询 3 秒内复用（Raydium SDK 和本页会查同样的代币账户）
  return async function routedFetch(_url, init) {
    let method = '', params = null, id = null;
    try { const b = JSON.parse(init.body); method = Array.isArray(b) ? (b[0] && b[0].method) : b.method; params = b.params; id = b.id; } catch (_) { }
    if (opts.intercept) { const r = await opts.intercept(method, init); if (r) return r; }
    const isIdx = INDEXED.has(method);
    const ckey = isIdx ? method + JSON.stringify(params) : null;
    if (ckey && cache.has(ckey) && Date.now() - cache.get(ckey).t < 3000) {
      const j = JSON.parse(cache.get(ckey).txt); j.id = id;
      return new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const list = isIdx ? indexed : plain;
    let last;
    const rounds = NO_RETRY.has(method) ? 1 : 3;
    for (let round = 0; round < rounds; round++) {
      if (round) await new Promise(r => setTimeout(r, 600 * round));
      for (const u of list) {
        try {
          const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const t = ac ? setTimeout(() => ac.abort(), 25000) : null;
          const r = await baseFetch(u, { ...init, signal: ac ? ac.signal : undefined });
          if (t) clearTimeout(t);
          const txt = await r.text();
          let j = null; try { j = JSON.parse(txt); } catch (_) { }
          const e = j && !Array.isArray(j) && j.error;
          const retry = !r.ok || !j || (e && (e.code === -32601 || e.code === 403 || e.code === 429 || e.code === -32005 || e.code === -32029 ||
            /token|not allowed|forbidden|rate limit|too many|unavailable|not supported/i.test(String(e.message || ''))));
          if (retry && !NO_RETRY.has(method)) { last = new Error(`${method}: ${u.replace(/\?.*$/, '')} HTTP ${r.status} ${txt.slice(0, 100)}`); log('RPC 切换: ' + last.message); continue; }
          if (ckey && j && !e) cache.set(ckey, { t: Date.now(), txt });
          return new Response(txt, { status: 200, headers: { 'content-type': 'application/json' } });
        } catch (err) { last = err; log('RPC 出错 ' + u.replace(/\?.*$/, '') + ' ' + method + ': ' + (err.message || err)); }
      }
    }
    throw new Error('RPC 节点暂时不可用，请稍后重试（' + ((last && last.message) || '') .slice(0, 160) + '）');
  };
}
function makeConnection(opts = {}) {
  return new Connection((opts.rpcPlain || RPC_PLAIN)[0], { commitment: 'confirmed', fetch: makeFetch(opts), disableRetryOnRateLimit: true });
}

// ---------------- 读链 ----------------
const Q64 = 2 ** 64;
const tickPrice = (t, dA, dB) => 1.0001 ** t * 10 ** (dA - dB);

async function readPool(conn) {
  const info = await conn.getAccountInfo(new PublicKey(POOL_ID), 'confirmed');
  if (!info) throw new Error('读不到池子账户');
  if (info.owner.toBase58() !== CLMM) throw new Error('池子账户不属于 Raydium CLMM，已拒绝');
  const r = PoolInfoLayout.decode(info.data);
  if (r.mintA.toBase58() !== MINT_A || r.mintB.toBase58() !== MINT_B) throw new Error('池子代币不对，已拒绝');
  if (r.vaultA.toBase58() !== VAULT_A || r.vaultB.toBase58() !== VAULT_B) throw new Error('池子金库地址不对（RPC 数据可疑），已拒绝');
  const dA = r.mintDecimalsA, dB = r.mintDecimalsB;
  const sqrtP = Number(BigInt(r.sqrtPriceX64.toString())) / Q64;
  return { raw: r, dA, dB, tick: r.tickCurrent, spacing: r.tickSpacing, sqrtP, P: sqrtP * sqrtP * 10 ** (dA - dB),
    vaultA: r.vaultA.toBase58(), vaultB: r.vaultB.toBase58() };
}

function enrich(pos, pool) {
  const d = pos.decoded, tl = d.tickLower, tu = d.tickUpper, L = Number(BigInt(d.liquidity.toString()));
  const sa = 1.0001 ** (tl / 2), sb = 1.0001 ** (tu / 2), sp = pool.sqrtP;
  let a0, a1;
  if (pool.tick < tl) { a0 = L * (sb - sa) / (sa * sb); a1 = 0; }
  else if (pool.tick >= tu) { a0 = 0; a1 = L * (sb - sa); }
  else { a0 = L * (sb - sp) / (sp * sb); a1 = L * (sp - sa); }
  const x = a0 / 10 ** pool.dA, y = a1 / 10 ** pool.dB;
  const inRange = tl <= pool.tick && pool.tick < tu;
  return { ...pos, tickLower: tl, tickUpper: tu, lo: tickPrice(tl, pool.dA, pool.dB), hi: tickPrice(tu, pool.dA, pool.dB), x, y, value: x * pool.P + y, inRange, liquidityZero: L === 0 };
}

async function readWallet(conn, owner, pool) {
  const ownerPk = new PublicKey(owner);
  // 依次查询（公共节点对并发的索引查询容易限流）；参数和 Raydium SDK 的查询一致，可复用缓存
  const t1 = await conn.getTokenAccountsByOwner(ownerPk, { programId: new PublicKey(TOKEN) });
  const t2 = await conn.getTokenAccountsByOwner(ownerPk, { programId: new PublicKey(TOKEN22) });
  const lamports = await conn.getBalance(ownerPk, 'confirmed');
  const u64 = (d, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) + BigInt(d[o + i]); return v; };
  const accs = [...t1.value, ...t2.value].map(a => {
    const d = a.account.data;
    return { pubkey: a.pubkey.toBase58(), mint: new PublicKey(d.slice(0, 32)).toBase58(), amount: u64(d, 64), program: a.account.owner.toBase58() };
  });
  const bal = m => accs.filter(a => a.mint === m).reduce((s, a) => s + a.amount, 0n);
  const rawA = bal(MINT_A), rawB = bal(MINT_B);
  const nfts = accs.filter(a => a.amount === 1n && a.mint !== MINT_A && a.mint !== MINT_B).map(a => a.mint);
  const pdas = nfts.map(m => getPdaPersonalPositionAddress(new PublicKey(CLMM), new PublicKey(m)).publicKey);
  const positions = [];
  for (let i = 0; i < pdas.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(pdas.slice(i, i + 100), 'confirmed');
    infos.forEach((inf, j) => {
      if (!inf || inf.owner.toBase58() !== CLMM || inf.data.length < PersonalPositionLayout.span) return;
      try {
        const d = PersonalPositionLayout.decode(inf.data);
        if (d.poolId.toBase58() !== POOL_ID) return;
        positions.push(enrich({ nft: nfts[i + j], pda: pdas[i + j].toBase58(), decoded: d }, pool));
      } catch (_) { }
    });
  }
  return { sol: lamports / 1e9, lamports, rawA, rawB, x: Number(rawA) / 10 ** pool.dA, y: Number(rawB) / 10 ** pool.dB,
    tokenAccounts: accs.map(a => a.pubkey), positions: positions.filter(q => !q.liquidityZero), allPositions: positions };
}

/** 仓位第一次上链的时间（秒）；查不到返回 null。 */
async function positionCreatedAt(conn, pda) {
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(pda), { limit: 1000 }, 'confirmed');
    if (!sigs.length || sigs.length >= 1000) return sigs.length ? 0 : null;
    return sigs[sigs.length - 1].blockTime || null;
  } catch (_) { return null; }
}

// ---------------- 策略算法（与机器人相同） ----------------
function targetShare(widthPct) {
  const w = widthPct / 100, r = 1 + w, l = 1 - w;
  const a = 1 - Math.sqrt(1 / r), b = 1 - Math.sqrt(l);
  return a / (a + b);
}
function planRebalance(P, s, usdc, cfg) {
  const w = targetShare(cfg.widthPct);
  const V = s * P + usdc;
  const Vuse = Math.min(V, cfg.maxAmountUsd > 0 ? cfg.maxAmountUsd : V);
  const tgtStock = w * Vuse, tgtUsdc = Vuse - tgtStock;
  let side = 'none', usd = 0;
  if (s * P < tgtStock - 1e-9) { side = 'buy'; usd = tgtStock - s * P; }
  else if (usdc < tgtUsdc - 1e-9) { side = 'sell'; usd = tgtUsdc - usdc; }
  const lo = P * (1 - cfg.widthPct / 100), hi = P * (1 + cfg.widthPct / 100);
  const delta = s * P - w * V;
  return { w, V, Vuse, capped: Vuse < V - 1e-9, tgtStock, tgtUsdc, side, usd, tokens: usd / P, lo, hi, delta };
}

// ---------------- Raydium 交易构造（只用公钥） ----------------
const toBN = x => new BN(BigInt(Math.max(0, Math.floor(x))).toString());
function priceToTick(price, dA, dB) { return Math.log(price / 10 ** (dA - dB)) / Math.log(1.0001); }
function rangeTicks(lo, hi, dA, dB, spacing) {
  const tl = Math.floor(priceToTick(lo, dA, dB) / spacing) * spacing, tu = Math.ceil(priceToTick(hi, dA, dB) / spacing) * spacing;
  return { tickLower: tl, tickUpper: tu, lo: 1.0001 ** tl * 10 ** (dA - dB), hi: 1.0001 ** tu * 10 ** (dA - dB) };
}
function amountsAt(L, tl, tu, sp) {
  const sa = 1.0001 ** (tl / 2), sb = 1.0001 ** (tu / 2);
  if (sp <= sa) return [L * (sb - sa) / (sa * sb), 0];
  if (sp >= sb) return [0, L * (sb - sa)];
  return [L * (sb - sp) / (sp * sb), L * (sp - sa)];
}

async function loadRaydium(conn, owner) {
  return Raydium.load({ connection: conn, owner: new PublicKey(owner), cluster: 'mainnet', disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: 'confirmed' });
}
const budget = p => ({ units: CU_LIMIT, microLamports: Math.max(0, Math.floor(p.pf || 0)) });

async function buildClose(ray, p, pos) {
  const pd = await ray.clmm.getPoolInfoFromRpc(POOL_ID);
  const { poolInfo, poolKeys, computePoolInfo } = pd;
  const slip = p.sl / 100, d = pos.decoded, L = Number(BigInt(d.liquidity.toString()));
  const dA = poolInfo.mintA.decimals, dB = poolInfo.mintB.decimals;
  const sp = Math.sqrt(Number(computePoolInfo.currentPrice) / 10 ** (dA - dB));
  const cands = [sp * Math.sqrt(1 - slip), sp, sp * Math.sqrt(1 + slip)].map(s => amountsAt(L, d.tickLower, d.tickUpper, s));
  const minA = Math.min(...cands.map(c => c[0])) * 0.999, minB = Math.min(...cands.map(c => c[1])) * 0.999;
  const r = await ray.clmm.decreaseLiquidity({
    poolInfo, poolKeys, ownerPosition: d, ownerInfo: { useSOLBalance: true, closePosition: true },
    liquidity: d.liquidity, amountMinA: toBN(minA), amountMinB: toBN(minB), txVersion: TxVersion.V0, computeBudgetConfig: budget(p),
  });
  return { kind: 'withdraw', tx: r.transaction, signers: r.signers || [], pd, info: { minA: minA / 10 ** dA, minB: minB / 10 ** dB } };
}

async function buildSwap(ray, p, side, amountInRaw) {
  const pd = await ray.clmm.getPoolInfoFromRpc(POOL_ID);
  const { poolInfo, poolKeys, computePoolInfo, tickData } = pd;
  const baseIn = side === 'sell';
  const inMint = poolInfo[baseIn ? 'mintA' : 'mintB'], outMint = poolInfo[baseIn ? 'mintB' : 'mintA'];
  const amountIn = toBN(amountInRaw);
  const q = PoolUtils.computeAmountOutFormat({
    poolInfo: computePoolInfo, tickarrayBitmapExtension: computePoolInfo.exBitmapInfo, tickArrayCache: tickData[POOL_ID],
    amountIn, tokenOut: outMint, slippage: p.sl / 100, epochInfo: await ray.fetchEpochInfo(), blockTimestamp: Math.floor(Date.now() / 1000),
  });
  const P = Number(computePoolInfo.currentPrice);
  const outRaw = Number(q.amountOut.amount.raw.toString()), inH = Number(amountInRaw) / 10 ** inMint.decimals, outH = outRaw / 10 ** outMint.decimals;
  const execPrice = baseIn ? outH / inH : inH / outH;
  const worst = baseIn ? (P - execPrice) / P : (execPrice - P) / P;
  if (worst > p.sl / 100 + 0.0011) throw new Error(`兑换价格偏离池子价格 ${(worst * 100).toFixed(3)}%，超过滑点上限 ${p.sl}%（另加 0.1% 手续费），已取消`);
  const r = await ray.clmm.swap({
    poolInfo, poolKeys, inputMint: inMint.address, amountIn, amountOutMin: q.minAmountOut.amount.raw,
    observationId: computePoolInfo.observationId, ownerInfo: { useSOLBalance: true }, remainingAccounts: q.remainingAccounts,
    txVersion: TxVersion.V0, computeBudgetConfig: budget(p),
  });
  const minOut = Number(q.minAmountOut.amount.raw.toString()) / 10 ** outMint.decimals;
  return { kind: 'swap', tx: r.transaction, signers: r.signers || [], pd, info: { side, P, execPrice, worst, inH, outH, minOut } };
}

async function buildOpen(ray, p, lo, hi, availA, availB) {
  const pd = await ray.clmm.getPoolInfoFromRpc(POOL_ID);
  const { poolInfo, poolKeys, computePoolInfo } = pd;
  const dA = poolInfo.mintA.decimals, dB = poolInfo.mintB.decimals, slip = p.sl / 100;
  const rt = rangeTicks(lo, hi, dA, dB, computePoolInfo.tickSpacing);
  const epochInfo = await ray.fetchEpochInfo();
  const need = async (inputA, amt) => PoolUtils.getLiquidityAmountOutFromAmountIn({ poolInfo, slippage: 0, inputA, tickLower: rt.tickLower, tickUpper: rt.tickUpper, amount: toBN(amt), add: true, amountHasFee: true, epochInfo });
  let base = 'MintA', baseAmt = Math.floor(availA * 0.998), otherMax, res = null;
  res = baseAmt > 0 ? await need(true, baseAmt) : null;
  const needB = res ? Number(res.amountB.amount.toString()) : Infinity;
  if (res && needB * (1 + slip) <= availB) otherMax = Math.min(availB, Math.ceil(needB * (1 + slip)) + 1);
  else {
    base = 'MintB'; baseAmt = Math.floor(availB * 0.998);
    if (baseAmt <= 0) throw new Error('钱包里的 USDC 和 AAPLx 不够开仓');
    res = await need(false, baseAmt); const needA = Number(res.amountA.amount.toString());
    if (needA * (1 + slip) > availA && needA > 0) {
      const k = availA / (needA * (1 + slip)) * 0.995; baseAmt = Math.floor(baseAmt * k); res = await need(false, baseAmt);
    }
    otherMax = Math.min(availA, Math.ceil(Number(res.amountA.amount.toString()) * (1 + slip)) + 1);
  }
  if (baseAmt <= 0) throw new Error('可用资金不足，无法开仓');
  const r = await ray.clmm.openPositionFromBase({
    poolInfo, poolKeys, tickLower: rt.tickLower, tickUpper: rt.tickUpper, base, ownerInfo: { useSOLBalance: true },
    baseAmount: toBN(baseAmt), otherAmountMax: toBN(otherMax), nft2022: true, txVersion: TxVersion.V0, computeBudgetConfig: budget(p),
  });
  const estA = Number(res.amountA.amount.toString()) / 10 ** dA, estB = Number(res.amountB.amount.toString()) / 10 ** dB;
  const maxA = base === 'MintA' ? baseAmt / 10 ** dA : otherMax / 10 ** dA;
  const maxB = base === 'MintB' ? baseAmt / 10 ** dB : otherMax / 10 ** dB;
  return { kind: 'open', tx: r.transaction, signers: r.signers || [], pd,
    info: { ...rt, base, baseAmt, otherMax, estA, estB, maxA, maxB, nft: r.extInfo && r.extInfo.nftMint && r.extInfo.nftMint.toBase58() } };
}

// ---------------- 交易安全检查 ----------------
const b58 = k => (typeof k === 'string' ? k : k.toBase58());
const hex8 = d => Array.from(d.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
const u32le = d => (d.length < 4 ? -1 : (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0);
const u64le = (d, off) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) + BigInt(d[off + i] || 0); return v; };
const pk32 = (d, off) => (d.length < off + 32 ? null : new PublicKey(d.slice(off, off + 32)).toBase58());

async function resolveKeys(conn, vtx) {
  const msg = vtx.message;
  const looks = msg.addressTableLookups || [];
  const alts = [];
  for (const l of looks) {
    const r = await conn.getAddressLookupTable(l.accountKey, { commitment: 'confirmed' });
    if (!r || !r.value) throw new Error('交易引用了读不到的地址表，已拒绝');
    alts.push(r.value);
  }
  const k = msg.getAccountKeys({ addressLookupTableAccounts: alts });
  return [...k.staticAccountKeys, ...(k.accountKeysFromLookups ? k.accountKeysFromLookups.writable : []), ...(k.accountKeysFromLookups ? k.accountKeysFromLookups.readonly : [])].map(b58);
}

/** 把交易拆成指令列表（已解析地址表）。 */
function listIxs(vtx, keys) {
  const msg = vtx.message;
  const nSig = msg.header.numRequiredSignatures;
  const staticKeys = msg.staticAccountKeys.map(b58);
  return msg.compiledInstructions.map(ix => {
    if (ix.programIdIndex >= keys.length) throw new Error('交易引用了未解析的地址，已拒绝');
    const accounts = ix.accountKeyIndexes.map(i => {
      if (i >= keys.length) throw new Error('交易引用了未解析的地址，已拒绝');
      return { pubkey: keys[i], isSigner: i < nSig };
    });
    return { programId: keys[ix.programIdIndex], accounts, data: Uint8Array.from(ix.data) };
  });
}

/**
 * ctx: { owner, extraSigners:[], vaults:[], ownerTokenAccounts:[], closePda? , maxFeeLamports? }
 * 返回 { programs:[...], ixNames:[...] }，不安全时抛中文错误。
 */
function assertSafeTx(vtx, keys, ctx) {
  const owner = ctx.owner;
  const msg = vtx.message;
  const staticKeys = msg.staticAccountKeys.map(b58);
  const nSig = msg.header.numRequiredSignatures;
  if (staticKeys[0] !== owner) throw new Error('交易的手续费付款人不是你的钱包，已拒绝');
  const okSigners = new Set([owner, ...(ctx.extraSigners || [])]);
  for (const s of staticKeys.slice(0, nSig)) if (!okSigners.has(s)) throw new Error('交易需要一个陌生的签名者 ' + s + '，已拒绝');
  const ownTok = new Set([owner, ...(ctx.ownerTokenAccounts || [])]);
  const tokDest = new Set([...ownTok, ...(ctx.vaults || [])]);
  const ixs = listIxs(vtx, keys);
  if (!ixs.length) throw new Error('空交易，已拒绝');
  const names = [];
  let cuLimit = 200000 * ixs.length, cuPrice = 0n, clmmCount = 0;
  for (const ix of ixs) {
    const pid = ix.programId, d = ix.data, acc = i => (ix.accounts[i] ? ix.accounts[i].pubkey : null);
    if (!ALLOWED_PROGRAMS.includes(pid)) throw new Error('交易含有不允许的程序 ' + pid + '，已拒绝');
    if (pid === CB) {
      if (d[0] === 2) { cuLimit = u32le(d.slice(1)); names.push('ComputeBudget.setLimit'); }
      else if (d[0] === 3) { cuPrice = u64le(d, 1); names.push('ComputeBudget.setPrice'); }
      else throw new Error('交易含有未允许的计算预算指令，已拒绝');
    } else if (pid === SYSTEM) {
      const disc = u32le(d);
      if (disc === 0) { // lamports u64 @4, space u64 @12, 所属程序 @20
        if (acc(0) !== owner || !okSigners.has(acc(1)) || acc(1) === owner) throw new Error('交易含有可疑的建账户指令，已拒绝');
        if (![TOKEN, TOKEN22].includes(pk32(d, 20))) throw new Error('建账户的所属程序不是代币程序，已拒绝');
        if (u64le(d, 4) > BigInt(MAX_RENT_LAMPORTS)) throw new Error('建账户押的 SOL 太多，已拒绝');
        names.push('System.createAccount');
      } else if (disc === 3) { // base @4, seed(u64 长度+内容) @36, lamports, space, 所属程序
        if (acc(0) !== owner || pk32(d, 4) !== owner) throw new Error('交易含有可疑的建账户指令，已拒绝');
        const len = Number(u64le(d, 36)), o = 44 + len;
        if (!(len <= 32) || ![TOKEN, TOKEN22].includes(pk32(d, o + 16))) throw new Error('建账户的所属程序不是代币程序，已拒绝');
        if (u64le(d, o) > BigInt(MAX_RENT_LAMPORTS)) throw new Error('建账户押的 SOL 太多，已拒绝');
        names.push('System.createAccountWithSeed');
      }
      else throw new Error(disc === 2 || disc === 11 ? '交易含有 SOL 转账，已拒绝' : '交易含有未允许的系统指令 ' + disc + '，已拒绝');
    } else if (pid === TOKEN || pid === TOKEN22) {
      const t = d.length ? d[0] : -1;
      if (t === 3 || t === 12) { const dest = t === 3 ? acc(1) : acc(2); if (!tokDest.has(dest)) throw new Error('交易含有把代币转给别人的指令，已拒绝'); names.push('Token.transfer'); }
      else if (t === 9) { if (acc(1) !== owner) throw new Error('关闭代币账户的退款地址不是你的钱包，已拒绝'); names.push('Token.closeAccount'); }
      else if (t === 17) names.push('Token.syncNative');
      else if (t === 1 || t === 16 || t === 18) { const o = t === 1 ? acc(2) : pk32(d, 1); if (o !== owner) throw new Error('建代币账户的所有者不是你，已拒绝'); names.push('Token.initAccount'); }
      else throw new Error('交易含有未允许的代币指令 ' + t + '，已拒绝');
    } else if (pid === ATA) {
      if (!(d.length === 0 || d[0] === 0 || d[0] === 1)) throw new Error('交易含有未允许的 ATA 指令，已拒绝');
      if (acc(0) !== owner || acc(2) !== owner) throw new Error('交易要给别人的钱包建代币账户，已拒绝');
      names.push('ATA.create');
    } else if (pid === CLMM) {
      const nm = DISC_NAME[hex8(d)];
      if (!nm) throw new Error('交易含有未允许的 Raydium 指令，已拒绝');
      const keysIn = ix.accounts.map(a => a.pubkey);
      if (nm === 'close_position') { if (!ctx.closePda || !keysIn.includes(ctx.closePda)) throw new Error('关闭的不是要撤的那个仓位，已拒绝'); }
      else if (!keysIn.includes(POOL_ID)) throw new Error('Raydium 指令不是这个池子的，已拒绝');
      if (acc(0) !== owner) throw new Error('Raydium 指令的付款人/所有者不是你的钱包，已拒绝');
      clmmCount++; names.push('Raydium.' + nm);
    } else if (pid === MEMO) names.push('Memo');
  }
  if (!clmmCount) throw new Error('交易里没有 Raydium 池子指令，已拒绝');
  const fee = Number(BigInt(Math.min(cuLimit, 1400000)) * cuPrice / 1000000n);
  if (fee > (ctx.maxFeeLamports || 20000000)) throw new Error('优先费过高，已拒绝');
  return { programs: [...new Set(ixs.map(i => i.programId))], ixNames: names, priorityLamports: fee };
}

// ---------------- 每一步的判断与构造 ----------------
const fmt = (x, n = 2) => Number(x).toFixed(n);
function bjStamp(sec) {
  const d = new Date(sec * 1000 + 8 * 3600e3), z = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())}`;
}

/** 链接本身是否还能用（不读链）。 */
function linkCheck(p, nowSec, connected) {
  if (nowSec >= p.e) return { ok: false, code: 'expired', reason: `链接已过期（有效期到 ${bjStamp(p.e)} 北京时间）。不需要操作，机器人会重新发链接。` };
  if (connected && connected !== p.w) return { ok: false, code: 'wallet', reason: `当前连接的钱包 ${connected} 不是这笔操作的钱包 ${p.w}，已停止。` };
  return { ok: true };
}

/** 判断第 step 步还需不需要做；需要就构造交易。 */
async function prepareStep(conn, p, step, opts = {}) {
  const nowSec = opts.nowSec || Math.floor(Date.now() / 1000);
  const lc = linkCheck(p, nowSec, opts.connected || p.w);
  if (!lc.ok) return { status: 'refuse', code: lc.code, reason: lc.reason };
  const pool = await readPool(conn);
  const w = await readWallet(conn, p.w, pool);
  const P = pool.P;
  const otherPos = w.positions.filter(q => q.nft !== p.n);
  // 链接创建之后开的新仓位
  const fresh = [];
  for (const q of otherPos) {
    const t = await positionCreatedAt(conn, q.pda);
    if (t === null || t >= p.c - 60) fresh.push({ ...q, createdAt: t });
  }
  const base = { pool, wallet: w, P, fresh };
  if (step === 'withdraw') {
    const pos = w.positions.find(q => q.nft === p.n);
    if (!pos) return { ...base, status: 'skip', reason: '不需要操作（已完成）：这个仓位已经撤掉了。' };
    if (w.sol < 0.0005) return { ...base, status: 'refuse', reason: `SOL 余额 ${fmt(w.sol, 4)} 不够付手续费。` };
    const ray = await loadRaydium(conn, p.w);
    const b = await buildClose(ray, p, pos);
    const summary = `撤出这一笔仓位：区间 ${fmt(pos.lo)} – ${fmt(pos.hi)}（${pos.inRange ? '在区间内' : '已出界'}），仓位编号 ${p.n}。` +
      `\n大约 ${fmt(pos.x, 4)} ${TK} + ${fmt(pos.y)} USDC（约 $${fmt(pos.value)}）连同手续费收益回到你自己的钱包，仓位关闭并退回押金。` +
      `\n最少收到 ${fmt(b.info.minA, 4)} AAPLx + ${fmt(b.info.minB)} USDC（滑点上限 ${p.sl}%）。`;
    return finish(conn, p, base, b, summary, { closePda: pos.pda });
  }
  if (fresh.length) {
    const q = fresh[0];
    return { ...base, status: 'done', reason: `不需要操作（已完成）：钱包里已经有一笔新开的仓位，区间 ${fmt(q.lo)} – ${fmt(q.hi)}${q.inRange ? '（在区间内）' : '（不在区间内）'}。` };
  }
  if (step === 'swap' || step === 'open') {
    if (p.se && nowSec >= p.se) return { ...base, status: 'refuse', reason: `已经过了本轮开仓时段（到 ${bjStamp(p.se)} 北京时间），不再兑换或开仓。` };
    if (p.p0 > 0 && Math.abs(P / p.p0 - 1) * 100 > p.dv) return { ...base, status: 'refuse', reason: `池子价格从 ${fmt(p.p0)} 变到 ${fmt(P)}，变化超过 ${p.dv}%。为安全已停止，请等机器人重新发链接。` };
    if (w.sol < p.ms) return { ...base, status: 'refuse', reason: `SOL 余额 ${fmt(w.sol, 4)} 低于保留 ${p.ms}，请先补一点 SOL。` };
    if (w.positions.some(q => q.nft === p.n)) return { ...base, status: 'refuse', reason: '要撤的仓位还在，先完成撤仓这一步。' };
    // 策略只持有一个仓位：池子里已经有仓位就不再兑换/开仓（防止两个链接各开一个）
    if (w.positions.length) return { ...base, status: 'refuse', reason: `钱包在这个池子里已经有 ${w.positions.length} 个仓位，不再兑换或开新仓。不需要操作。` };
    // 止损：参考价 = 本轮第一次开仓时的池子价格。价格到了参考价下方 sp% 就不再兑换/开仓（电脑端发链接之后价格继续跌的情况）。
    // 本轮第一次开仓没有参考价（不受止损限制）；配平一定有参考价，链接里没有就拒绝。
    if (p.a === 'rebalance' && !(p.rf > 0)) return { ...base, status: 'refuse', reason: '配平链接里没有本轮开仓参考价，无法判断止损，不兑换也不开仓。请更新电脑上的机器人。' };
    if (p.rf > 0 && P <= p.rf * (1 - p.sp / 100)) return { ...base, status: 'refuse', reason: `池子价格 ${fmt(P)} 已经比本轮开仓价 ${fmt(p.rf)} 低 ${fmt((1 - P / p.rf) * 100)}%（止损线 ${p.sp}%），本轮不再兑换或开仓。不需要操作。` };
  }
  const cfg = { widthPct: p.wd, maxAmountUsd: p.mx };
  const pl = planRebalance(P, w.x, w.y, cfg);
  if (step === 'swap') {
    if (pl.side === 'none' || pl.usd < 1) return { ...base, plan: pl, status: 'skip', reason: `不需要兑换：钱包里 ${fmt(w.x, 4)} AAPLx + ${fmt(w.y)} USDC 已接近目标比例（Δ=${fmt(pl.delta)} 美元）。` };
    let limit = p.mx;
    if (p.su > 0) limit = Math.min(limit, Math.max(p.su * 1.5, p.su + 25));
    const usdUse = Math.min(pl.usd, limit), capped = usdUse < pl.usd - 1e-9;
    const rawIn = pl.side === 'sell'
      ? Math.min(Number(w.rawA), Math.floor(usdUse / P * 10 ** pool.dA))
      : Math.min(Number(w.rawB), Math.floor(usdUse * 10 ** pool.dB));
    if (!(rawIn > 0)) return { ...base, plan: pl, status: 'skip', reason: '可兑换数量为 0，不需要兑换。' };
    const ray = await loadRaydium(conn, p.w);
    const b = await buildSwap(ray, p, pl.side, rawIn);
    const sw = pl.side === 'sell'
      ? `卖出 ${fmt(b.info.inH, 6)} 个 ${TK}（约 $${fmt(b.info.inH * P)}），换回约 ${fmt(b.info.outH)} USDC，最少 ${fmt(b.info.minOut)} USDC`
      : `用 ${fmt(b.info.inH)} USDC 买入约 ${fmt(b.info.outH, 6)} 个 ${TK}，最少 ${fmt(b.info.minOut, 6)} 个`;
    const summary = `在 AAPLx/USDC 池子里${sw}。` +
      `\n池子价格 ${fmt(P)}，成交价约 ${fmt(b.info.execPrice)}（含 0.1% 池子手续费，滑点上限 ${p.sl}%）。` +
      `\n现在钱包：${fmt(w.x, 4)} AAPLx + ${fmt(w.y)} USDC；目标 AAPLx 占比 ${fmt(pl.w * 100)}%，Δ = s·P − w·V = ${pl.delta >= 0 ? '+' : ''}${fmt(pl.delta)} 美元。` +
      (capped ? `\n兑换金额已按上限 $${fmt(limit)} 封顶。` : '') + '\n币只在你钱包和池子之间流动，不会转到别人的地址。';
    return finish(conn, p, base, b, summary, { plan: pl });
  }
  if (step === 'open') {
    const availA = Math.min(Number(w.rawA), Math.floor(pl.tgtStock / P * 1.01 * 10 ** pool.dA));
    const availB = Math.min(Number(w.rawB), Math.floor(pl.tgtUsdc * 1.01 * 10 ** pool.dB));
    if (availA / 10 ** pool.dA * P + availB / 10 ** pool.dB < 1) return { ...base, status: 'refuse', reason: '钱包里没有可开仓的 AAPLx / USDC。' };
    const ray = await loadRaydium(conn, p.w);
    const b = await buildOpen(ray, p, pl.lo, pl.hi, availA, availB);
    const summary = `按池子现价 ${fmt(P)} 开新仓位：区间 ${fmt(b.info.lo)} – ${fmt(b.info.hi)}（±${p.wd}%）。` +
      `\n投入约 ${fmt(b.info.estA, 6)} ${TK} + ${fmt(b.info.estB)} USDC（约 $${fmt(b.info.estA * P + b.info.estB)}），最多 ${fmt(b.info.maxA, 6)} AAPLx / ${fmt(b.info.maxB)} USDC。` +
      `\n会押约 0.01–0.02 SOL 的账户租金（撤仓时退回）。只在这个池子开仓。`;
    return finish(conn, p, base, b, summary, { plan: pl });
  }
  return { status: 'refuse', reason: '未知步骤' };
}

async function finish(conn, p, base, b, summary, extra) {
  const keys = await resolveKeys(conn, b.tx);
  const guardCtx = {
    owner: p.w, extraSigners: (b.signers || []).map(s => s.publicKey.toBase58()),
    vaults: [base.pool.vaultA, base.pool.vaultB], ownerTokenAccounts: await ownerAtas(p.w, base.wallet), closePda: extra.closePda,
  };
  const guard = assertSafeTx(b.tx, keys, guardCtx);
  return { ...base, ...extra, status: 'build', step: b.kind, summary, built: b, keys, guard, guardCtx, builtAt: Date.now() };
}

async function ownerAtas(owner, w) {
  const { getAssociatedTokenAddressSync } = require('@solana/spl-token');
  const o = new PublicKey(owner);
  const list = [...w.tokenAccounts];
  list.push(getAssociatedTokenAddressSync(new PublicKey(MINT_A), o, false, new PublicKey(TOKEN22)).toBase58());
  list.push(getAssociatedTokenAddressSync(new PublicKey(MINT_B), o, false, new PublicKey(TOKEN)).toBase58());
  return list;
}

/** 把 SDK 生成的额外签名者（开仓 NFT 铸币账户）签上。 */
function partialSign(b) { if (b.signers && b.signers.length) b.tx.sign(b.signers); return b.tx; }

async function simulate(conn, vtx) {
  const r = await conn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  return { err: r.value.err, units: r.value.unitsConsumed, logs: r.value.logs || [] };
}

module.exports = {
  POOL_ID, CLMM, MINT_A, MINT_B, VAULT_A, VAULT_B, ALLOWED_PROGRAMS, TOKEN, TOKEN22, ATA, SYSTEM, CB, MEMO, DISC,
  encodeLink, decodeLink, normalizeParams, stepsFor, linkCheck, bjStamp,
  makeFetch, makeConnection, readPool, readWallet, positionCreatedAt,
  targetShare, planRebalance, rangeTicks,
  buildClose, buildSwap, buildOpen, loadRaydium,
  resolveKeys, listIxs, assertSafeTx, prepareStep, partialSign, simulate,
  VersionedTransaction, PublicKey,
};
