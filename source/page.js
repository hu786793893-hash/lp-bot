'use strict';
// 签名页界面：读取 # 后面的任务参数 → 连接钱包 → 每一步重新读链、构造、检查、模拟 → 钱包签名 → 等确认 → 下一步。
const C = require('./core');
const { VersionedTransaction } = require('@solana/web3.js');

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function msg(cls, html) { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; $('msgs').appendChild(d); return d; }
function clearMsgs() { $('msgs').innerHTML = ''; }
function log(t) { const el = $('log'); el.textContent += new Date().toISOString().slice(11, 19) + ' ' + t + '\n'; }

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58(bytes) {
  bytes = Array.from(bytes); const digits = [0];
  for (let i = 0; i < bytes.length; i++) { let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; } }
  let s = ''; for (let k = 0; k < bytes.length && bytes[k] === 0; k++) s += '1';
  for (let q = digits.length - 1; q >= 0; q--) s += B58[digits[q]];
  return s;
}
function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i + 0x8000))); return btoa(s); }
function fromB64(t) { const bin = atob(t), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
function sigToString(sig) { if (!sig) return null; if (typeof sig === 'string') return sig; if (sig.signature) return sigToString(sig.signature); if (sig.length === 64) return bs58(sig); return String(sig); }

// ---------- 钱包检测（与已在币安钱包里测试通过的模板相同） ----------
const stdWallets = [];
function registerStd(...ws) { for (const w of ws) if (w && !stdWallets.includes(w)) { stdWallets.push(w); log('钱包注册: ' + w.name); refreshStatus(); } return () => { }; }
const stdApi = Object.freeze({ register: registerStd, get: () => stdWallets.slice(), on: () => () => { } });
try { window.addEventListener('wallet-standard:register-wallet', e => { try { e.detail(stdApi); } catch (err) { log('注册出错: ' + err.message); } }); } catch (_) { }
try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: stdApi })); } catch (_) { }
try { const nw = navigator.wallets; if (Array.isArray(nw)) nw.forEach(cb => { try { cb(stdApi); } catch (_) { } }); } catch (_) { }
function stdSupportsSolana(w) { const f = w.features || {}; return !!(f['standard:connect'] && (f['solana:signAndSendTransaction'] || f['solana:signTransaction'])); }
function isBinanceEnv() { try { return !!(window.binancew3w || (window.ethereum && window.ethereum.isBinance) || window.isBinance || /Binance|BNC\//i.test(navigator.userAgent)); } catch (_) { return false; } }
function pickWallet() {
  for (const w of stdWallets) if (/binance/i.test(w.name || '') && stdSupportsSolana(w)) return { kind: 'std', name: w.name, w };
  try { const bs = window.binancew3w && window.binancew3w.solana; if (bs && (bs.connect || bs.signTransaction)) return { kind: 'legacy', name: 'Binance Wallet', p: bs }; } catch (_) { }
  try { if (window.phantom && window.phantom.solana && window.phantom.solana.isPhantom) return { kind: 'legacy', name: 'Phantom', p: window.phantom.solana }; } catch (_) { }
  for (const w of stdWallets) if (stdSupportsSolana(w)) return { kind: 'std', name: w.name, w };
  try { if (window.solana && (window.solana.connect || window.solana.signTransaction)) return { kind: 'legacy', name: window.solana.isPhantom ? 'Phantom' : (window.solana.isBinance ? 'Binance Wallet' : 'window.solana'), p: window.solana }; } catch (_) { }
  return null;
}
async function waitForWallet(ms) { const t0 = Date.now(); let w; while (!(w = pickWallet()) && Date.now() - t0 < ms) await sleep(250); return w; }
function refreshStatus() { const w = pickWallet(); if (w) { $('status').textContent = '已检测到钱包：' + w.name; $('noProvider').classList.add('hidden'); } return w; }

function binanceLinks(url, chainId) {
  const startPagePath = btoa('/pages/browser/index');
  const startPageQuery = btoa('url=' + url + '&defaultChainId=' + chainId);
  const bnc = 'bnc://app.binance.com/mp/app?appId=yFK5FCqYprrXDiVFbhyRx7&startPagePath=' + startPagePath + '&startPageQuery=' + startPageQuery;
  const dp = btoa(bnc);
  return { bnc, http: 'https://app.binance.com/en/download?_dp=' + dp, clean: (startPageQuery + dp).indexOf('+') < 0 };
}
function setupOpenLinks() {
  const base = location.origin + location.pathname, hash = location.hash || '';
  let links = null, chosen = base + hash;
  for (let n = 0; n < 60; n++) { const u = (n === 0 ? base : base + '?b=' + n) + hash; links = binanceLinks(u, 1); chosen = u; if (links.clean) break; }
  $('openBinance').href = links.http; $('openBinanceBnc').href = links.bnc;
  $('pageUrl').value = base + hash;
  $('openPhantom').href = 'https://phantom.app/ul/browse/' + encodeURIComponent(chosen) + '?ref=' + encodeURIComponent(location.origin);
}
$('copyBtn').addEventListener('click', function () {
  const inp = $('pageUrl'), v = inp.value, btn = this;
  const done = () => { btn.textContent = '已复制'; setTimeout(() => { btn.textContent = '复制'; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, () => { inp.select(); try { document.execCommand('copy'); done(); } catch (_) { } });
  else { inp.focus(); inp.select(); try { document.execCommand('copy'); done(); } catch (_) { } }
});

// ---------- 状态 ----------
let conn = null;
let P = null, steps = [], cur = 0, sel = null, wc = null, prepared = null, busy = false, finished = false;
const STEP_NAME = { withdraw: '撤仓', swap: '兑换', open: '开仓' };
const ACTION_NAME = { withdraw: '每日撤仓', rebalance: '出界配平（撤仓 → 兑换 → 开仓）', open: '开仓（需要时先兑换）' };
const stepState = {};

function renderSteps() {
  $('steps').innerHTML = steps.map((s, i) => {
    const st = stepState[i] || (i === cur && !finished ? '当前' : '等待');
    const icon = { '已完成': '✅', '已跳过': '⏭️', '当前': '👉', '等待': '⏳', '失败': '❌', '不需要': '✅' }[st] || '•';
    return `<div class="step">${icon} 第 ${i + 1} 步：${STEP_NAME[s]} <span class="small">${esc(st)}</span></div>`;
  }).join('');
}
function setBtn(text, enabled, cls) { const b = $('mainBtn'); b.textContent = text; b.disabled = !enabled; b.className = 'btn' + (cls ? ' ' + cls : ''); b.classList.toggle('hidden', !text); }
function stopAll(cls, text) { finished = true; prepared = null; $('summary').classList.add('hidden'); msg(cls, esc(text).replace(/\n/g, '<br>')); setBtn('', false); renderSteps(); }

function isReject(e) { const m = ((e && (e.message || e.toString())) || '').toLowerCase(); return (e && e.code === 4001) || /reject|cancel|denied|拒绝|取消/.test(m); }
function rawFromSigned(res) {
  if (!res) throw new Error('钱包没有返回已签名交易');
  if (Array.isArray(res)) res = res[0];
  if (res.signedTransaction) res = res.signedTransaction;
  if (typeof res.serialize === 'function') return new Uint8Array(res.serialize());
  if (res instanceof Uint8Array || Array.isArray(res) || (res.length && typeof res[0] === 'number')) return new Uint8Array(res);
  if (typeof res === 'string') return fromB64(res);
  throw new Error('无法识别钱包返回的签名结果');
}
async function sendRaw(raw) { return await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }); }

async function connectWallet(s) {
  if (s.kind === 'std') {
    const res = await s.w.features['standard:connect'].connect();
    const accts = (res && res.accounts && res.accounts.length ? res.accounts : s.w.accounts) || [];
    const acct = accts.filter(a => (a.chains || []).some(c => /^solana:/.test(c)))[0] || accts[0];
    if (!acct) throw new Error('钱包没有返回 Solana 账户（请确认币安钱包已启用 Solana 网络）');
    const chain = ((acct.chains || []).filter(c => /^solana:/.test(c) && !/devnet|testnet|localnet/.test(c))[0]) || 'solana:mainnet';
    return { address: acct.address, account: acct, chain };
  }
  const p = s.p, r = await p.connect();
  const pk = (r && r.publicKey) || p.publicKey || r;
  const a = pk && (pk.toBase58 ? pk.toBase58() : pk.toString());
  if (!a || a === '[object Object]') throw new Error('无法读取钱包地址');
  return { address: a };
}

/** 交给钱包签名。返回 {sig, raw?}；raw 表示由本页广播。 */
async function walletSign(b) {
  const tx = b.tx, bytes = tx.serialize();
  const extra = (b.signers || []).length > 0;
  if (sel.kind === 'std') {
    const f = sel.w.features;
    // 有额外签名者（开仓的 NFT 账户）时先用 signTransaction，这样能检查并补签
    const order = extra ? ['sign', 'send'] : ['send', 'sign'];
    let lastErr;
    for (const o of order) {
      if (o === 'send' && f['solana:signAndSendTransaction']) {
        try { log('调用 solana:signAndSendTransaction');
          const out = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: wc.account, chain: wc.chain, transaction: bytes, options: { preflightCommitment: 'confirmed' } });
          return { sig: sigToString(Array.isArray(out) ? out[0] : out) };
        } catch (e) { if (isReject(e)) throw e; lastErr = e; log('signAndSend 失败: ' + (e.message || e)); }
      }
      if (o === 'sign' && f['solana:signTransaction']) {
        try { log('调用 solana:signTransaction');
          const o2 = await f['solana:signTransaction'].signTransaction({ account: wc.account, chain: wc.chain, transaction: bytes });
          return checkSigned(rawFromSigned(o2), b);
        } catch (e) { if (isReject(e)) throw e; lastErr = e; log('signTransaction 失败: ' + (e.message || e)); }
      }
    }
    throw lastErr || new Error('该钱包不支持签名交易');
  }
  const p = sel.p; let lastErr;
  const order = extra ? ['sign', 'send'] : ['send', 'sign'];
  for (const o of order) {
    if (o === 'send' && typeof p.signAndSendTransaction === 'function') {
      try { log('调用 provider.signAndSendTransaction'); const r = await p.signAndSendTransaction(tx); return { sig: sigToString(r) }; }
      catch (e) { if (isReject(e)) throw e; lastErr = e; log('signAndSend 失败: ' + (e.message || e)); }
    }
    if (o === 'sign' && typeof p.signTransaction === 'function') {
      try { log('调用 provider.signTransaction'); const st = await p.signTransaction(tx); return checkSigned(rawFromSigned(st), b); }
      catch (e) { if (isReject(e)) throw e; lastErr = e; log('signTransaction 失败: ' + (e.message || e)); }
    }
  }
  throw lastErr || new Error('该钱包不支持签名交易');
}

/** 钱包签完返回的交易：重新做安全检查，补上 NFT 账户签名，确认钱包签名在。 */
async function checkSigned(raw, b) {
  const vt = VersionedTransaction.deserialize(raw);
  const same = b64(vt.message.serialize()) === b64(b.tx.message.serialize());
  if (!same) {
    log('钱包改动了交易内容，重新检查');
    const keys = await C.resolveKeys(conn, vt);
    C.assertSafeTx(vt, keys, prepared.guardCtx);
  }
  if (b.signers && b.signers.length) vt.sign(b.signers);
  const s0 = vt.signatures[0];
  if (!s0 || s0.every(x => x === 0)) throw new Error('钱包返回的交易没有签名');
  const out = vt.serialize();
  return { sig: bs58(vt.signatures[0]), raw: out };
}

async function waitConfirm(sig, raw, box) {
  for (let i = 0; i < 60; i++) {
    try {
      if (raw && i > 0 && i % 2 === 0) sendRaw(raw).catch(() => { });
      const r = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
      const s = r && r.value && r.value[0];
      if (s) {
        if (s.err) return { ok: false, err: s.err };
        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return { ok: true };
        box.innerHTML = '已上链，等待确认…（' + esc(s.confirmationStatus || 'processed') + '）';
      } else box.innerHTML = '等待上链…（' + (i + 1) + '）';
    } catch (e) { box.innerHTML = '查询出错，重试中…'; }
    await sleep(2000);
  }
  return { ok: false, timeout: true };
}

/** 等链上状态反映出这一步的结果（不同 RPC 节点可能稍慢）。 */
async function waitEffect(step, before) {
  for (let i = 0; i < 12; i++) {
    try {
      const pool = await C.readPool(conn), w = await C.readWallet(conn, P.w, pool);
      if (step === 'withdraw' && !w.positions.some(q => q.nft === P.n)) return true;
      if (step === 'swap' && (w.rawA !== before.rawA || w.rawB !== before.rawB)) return true;
      if (step === 'open' && w.positions.length > before.positions.length) return true;
    } catch (_) { }
    await sleep(2500);
  }
  return false;
}

async function prepareCurrent() {
  if (finished) return;
  while (cur < steps.length) {
    const step = steps[cur];
    renderSteps();
    $('summary').classList.add('hidden');
    setBtn('正在核对链上…', false);
    const box = msg('card', `第 ${cur + 1} 步（${STEP_NAME[step]}）：正在重新读取链上数据，核对是否还需要…`);
    let r;
    try { r = await C.prepareStep(conn, P, step, { connected: wc.address }); }
    catch (e) { box.remove(); log('构造失败: ' + (e.stack || e.message)); msg('err', '这一步没法构造交易：' + esc(e.message || e)); setBtn('重试这一步', true, 'sec'); return; }
    box.remove();
    if (r.status === 'refuse') { stopAll((r.code === 'expired' || /不需要/.test(r.reason)) ? 'warn' : 'err', r.reason); return; }
    if (r.status === 'done') { for (let i = cur; i < steps.length; i++) stepState[i] = '不需要'; stopAll('ok', r.reason); return; }
    if (r.status === 'skip') { stepState[cur] = '已跳过'; msg('small', `第 ${cur + 1} 步 ${STEP_NAME[step]}：${esc(r.reason)}`); cur++; continue; }
    // 先在主网模拟（不发送）
    const sim = await C.simulate(conn, r.built.tx).catch(e => ({ err: e.message, logs: [] }));
    if (sim.err) { log('模拟失败: ' + JSON.stringify(sim.err) + '\n' + (sim.logs || []).slice(-6).join('\n')); msg('err', '链上模拟没通过，这一步没有发给钱包：' + esc(JSON.stringify(sim.err))); setBtn('重试这一步', true, 'sec'); return; }
    log(`模拟通过：${sim.units} CU；指令 ${r.guard.ixNames.join(', ')}`);
    prepared = r;
    $('summary').innerHTML = `<b>第 ${cur + 1} 步：${STEP_NAME[step]}</b><br>` + esc(r.summary).replace(/\n/g, '<br>') +
      `<div class="small" style="margin-top:8px">交易只含：${esc(r.guard.ixNames.join('、'))}。手续费约 ${(0.000005 + r.guard.priorityLamports / 1e9 + (r.built.signers.length ? 0.000005 : 0)).toFixed(6)} SOL。链上模拟已通过。</div>`;
    $('summary').classList.remove('hidden');
    setBtn(`签名第 ${cur + 1} 步：${STEP_NAME[step]}`, true);
    return;
  }
  finished = true; renderSteps();
  msg('ok', '全部完成 ✅ 这一轮不需要再签了。');
  setBtn('', false);
}

async function signCurrent() {
  const step = steps[cur];
  let r = prepared;
  if (!r) return prepareCurrent();
  const age = Date.now() - r.builtAt;
  if (age > 5 * 60e3) { msg('warn', '数据超过 5 分钟，已重新读取。请看一下新的内容再点签名。'); prepared = null; return prepareCurrent(); }
  const lc = C.linkCheck(P, Math.floor(Date.now() / 1000), wc.address);
  if (!lc.ok) return stopAll('warn', lc.reason);
  if (age > 40e3) {
    log('刷新 blockhash');
    const bh = await conn.getLatestBlockhash('confirmed');
    r.built.tx.message.recentBlockhash = bh.blockhash;
    r.built.tx.signatures = r.built.tx.signatures.map(() => new Uint8Array(64));
    const sim = await C.simulate(conn, r.built.tx).catch(e => ({ err: e.message }));
    if (sim.err) { prepared = null; msg('warn', '链上情况变了，重新核对…'); return prepareCurrent(); }
    r.builtAt = Date.now();
  }
  C.partialSign(r.built);
  const before = { rawA: r.wallet.rawA, rawB: r.wallet.rawB, positions: r.wallet.positions };
  const hint = msg('card', '请在钱包弹窗里确认。只应看到这个池子的操作，没有把币转给别人。');
  let res;
  try { res = await walletSign(r.built); }
  finally { hint.remove(); }
  if (res.raw) { try { await sendRaw(res.raw); } catch (e) { msg('err', '广播失败：' + esc(e.message)); } }
  if (!res.sig) throw new Error('钱包没有返回交易签名');
  prepared = null;
  $('summary').classList.add('hidden');
  const box = msg('card', '已提交，等待上链…<br><a target="_blank" href="https://solscan.io/tx/' + encodeURIComponent(res.sig) + '">在 Solscan 查看</a>');
  setBtn('等待确认…', false);
  const c = await waitConfirm(res.sig, res.raw, box);
  if (!c.ok) {
    box.className = 'err';
    box.innerHTML = (c.timeout ? '一直没等到确认。可以稍后重新打开这个链接，页面会重新核对。' : '交易失败：' + esc(JSON.stringify(c.err))) +
      '<br><a target="_blank" href="https://solscan.io/tx/' + encodeURIComponent(res.sig) + '">在 Solscan 查看</a>';
    stepState[cur] = '失败'; renderSteps(); setBtn('重新核对这一步', true, 'sec'); return;
  }
  box.className = 'ok';
  box.innerHTML = `第 ${cur + 1} 步 ${STEP_NAME[step]} 已确认 ✅ <a target="_blank" href="https://solscan.io/tx/${encodeURIComponent(res.sig)}">Solscan</a>`;
  stepState[cur] = '已完成';
  cur++;
  if (cur < steps.length) { setBtn('等待链上更新…', false); await waitEffect(step, before); }
  await prepareCurrent();
}

$('mainBtn').addEventListener('click', async () => {
  if (busy || finished) return; busy = true;
  try {
    if (!wc) {
      sel = pickWallet() || await waitForWallet(2500);
      if (!sel) { $('noProvider').classList.remove('hidden'); msg('err', '未检测到钱包。请用币安 App 的钱包浏览器打开本页。'); return; }
      wc = await connectWallet(sel);
      log('已连接 ' + sel.name + ' ' + wc.address);
      const lc = C.linkCheck(P, Math.floor(Date.now() / 1000), wc.address);
      if (!lc.ok) { const a = wc.address; wc = null; return stopAll(lc.code === 'wallet' ? 'err' : 'warn', lc.reason); }
      msg('small', '已连接钱包：' + esc(wc.address));
      await prepareCurrent();
    } else if (prepared) await signCurrent();
    else await prepareCurrent();
  } catch (e) {
    const m = isReject(e) ? '你在钱包里拒绝了。可以再点一次重新签。' : ((e && (e.message || e.toString())) || '未知错误');
    log('出错: ' + (e && e.stack || m));
    msg('err', esc(m));
    if (!finished) { if (prepared) setBtn(`签名第 ${cur + 1} 步：${STEP_NAME[steps[cur]]}`, true); else setBtn('重试这一步', true, 'sec'); }
  } finally { busy = false; }
});

// ---------- 启动 ----------
(async function init() {
  setupOpenLinks();
  try { P = C.normalizeParams(C.decodeLink(location.hash)); }
  catch (e) { $('info').innerHTML = '<b>链接无效</b><br>' + esc(e.message) + '<br><span class="small">请直接点机器人邮件里的链接（要包含 # 后面的部分）。</span>'; setBtn('', false); return; }
  conn = C.makeConnection({ log }); // 只用内置节点，不用链接里的 RPC
  steps = C.stepsFor(P);
  $('info').innerHTML = `<b>${esc(ACTION_NAME[P.a])}</b><br>钱包：<span class="mono">${esc(P.w)}</span><br>` +
    (P.n ? `要撤的仓位：<span class="mono">${esc(P.n)}</span><br>` : '') +
    `区间宽度 ±${P.wd}%，单次最多 $${P.mx}，滑点上限 ${P.sl}%` + (P.rf > 0 ? `，23:00 参考价 ${P.rf}（低于 ${(P.rf * (1 - P.sp / 100)).toFixed(2)} 不再兑换/开仓）` : '') + `<br>链接有效期到 <b>${C.bjStamp(P.e)}</b>（北京时间）` +
    `<div class="small">池子：Raydium CLMM AAPLx/USDC 0.1%（${C.POOL_ID.slice(0, 6)}…${C.POOL_ID.slice(-5)}）。每一步签名前都会重新读链核对，不需要的步骤会自动跳过。</div>`;
  renderSteps();
  const lc = C.linkCheck(P, Math.floor(Date.now() / 1000));
  if (!lc.ok) { stopAll('warn', lc.reason); }
  else setBtn('连接钱包并核对', true);
  const w = await waitForWallet(3000);
  if (w) refreshStatus();
  else { $('status').textContent = isBinanceEnv() ? '在币安浏览器中，但没检测到 Solana 钱包。请先启用 Solana 网络后刷新。' : '未检测到钱包'; $('noProvider').classList.remove('hidden'); }
})();

window.LPSIGN = { C, VersionedTransaction, state: () => ({ P, steps, cur, stepState, finished, prepared: !!prepared, wallet: wc && wc.address }) };
