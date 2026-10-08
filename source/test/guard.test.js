// 交易安全检查：恶意交易必须被拒绝，正常 Raydium 交易必须通过。（不读链）
const assert = require('assert');
const { PublicKey, Keypair, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction, ComputeBudgetProgram } = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const C = require('../core');
const owner = Keypair.generate().publicKey, evil = Keypair.generate().publicKey;
const O = owner.toBase58();
const vaultA = Keypair.generate().publicKey.toBase58(), vaultB = Keypair.generate().publicKey.toBase58();
const ownAta = spl.getAssociatedTokenAddressSync(new PublicKey(C.MINT_B), owner).toBase58();
const evilAta = spl.getAssociatedTokenAddressSync(new PublicKey(C.MINT_B), evil).toBase58();
const ctx = { owner: O, extraSigners: [], vaults: [vaultA, vaultB], ownerTokenAccounts: [ownAta] };
const disc = n => Buffer.from(C.DISC[n], 'hex');
const clmmIx = (name, extraKeys = [], payer = owner) => new TransactionInstruction({ programId: new PublicKey(C.CLMM), keys: [{ pubkey: payer, isSigner: true, isWritable: true }, { pubkey: new PublicKey(C.POOL_ID), isSigner: false, isWritable: true }, ...extraKeys], data: Buffer.concat([disc(name), Buffer.alloc(16)]) });
const cb = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })];
function tx(ixs, payer = owner) {
  const m = new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(m);
}
const check = (t, c = ctx) => C.assertSafeTx(t, t.message.staticAccountKeys.map(k => k.toBase58()), c);
const rejects = (name, t, re, c) => { assert.throws(() => check(t, c), re, name); console.log('  拒绝 ✓', name); };

// 正常
const ok = check(tx([...cb, clmmIx('swap_v2')]));
assert.deepStrictEqual(ok.programs.sort(), [C.CB, C.CLMM].sort());
console.log('  通过 ✓ 正常 swap_v2');
check(tx([...cb, spl.createAssociatedTokenAccountIdempotentInstruction(owner, new PublicKey(ownAta), owner, new PublicKey(C.MINT_B)), clmmIx('decrease_liquidity_v2')]));
console.log('  通过 ✓ 建自己的 ATA + 撤流动性');

rejects('SOL 转账给别人', tx([...cb, clmmIx('swap_v2'), SystemProgram.transfer({ fromPubkey: owner, toPubkey: evil, lamports: 1000 })]), /SOL 转账/);
rejects('SOL 转给自己也不行（只允许建账户）', tx([...cb, clmmIx('swap_v2'), SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 1 })]), /SOL 转账/);
rejects('代币转给别人', tx([...cb, clmmIx('swap_v2'), spl.createTransferCheckedInstruction(new PublicKey(ownAta), new PublicKey(C.MINT_B), new PublicKey(evilAta), owner, 1n, 6)]), /代币转给别人/);
rejects('代币 transfer 给别人', tx([...cb, clmmIx('swap_v2'), spl.createTransferInstruction(new PublicKey(ownAta), new PublicKey(evilAta), owner, 1n)]), /代币转给别人/);
rejects('授权 approve', tx([...cb, clmmIx('swap_v2'), spl.createApproveInstruction(new PublicKey(ownAta), evil, owner, 1n)]), /未允许的代币指令/);
rejects('改权限 setAuthority', tx([...cb, clmmIx('swap_v2'), spl.createSetAuthorityInstruction(new PublicKey(ownAta), owner, spl.AuthorityType.AccountOwner, evil)]), /未允许的代币指令/);
rejects('关闭账户退款给别人', tx([...cb, clmmIx('swap_v2'), spl.createCloseAccountInstruction(new PublicKey(ownAta), evil, owner)]), /退款地址/);
rejects('给别人建 ATA', tx([...cb, spl.createAssociatedTokenAccountIdempotentInstruction(owner, new PublicKey(evilAta), evil, new PublicKey(C.MINT_B)), clmmIx('swap_v2')]), /给别人/);
rejects('陌生程序', tx([...cb, clmmIx('swap_v2'), new TransactionInstruction({ programId: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'), keys: [], data: Buffer.alloc(1) })]), /不允许的程序/);
rejects('别的池子', tx([...cb, new TransactionInstruction({ programId: new PublicKey(C.CLMM), keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: evil, isSigner: false, isWritable: true }], data: Buffer.concat([disc('swap_v2'), Buffer.alloc(16)]) })]), /不是这个池子/);
rejects('未知 Raydium 指令', tx([...cb, new TransactionInstruction({ programId: new PublicKey(C.CLMM), keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: new PublicKey(C.POOL_ID), isSigner: false, isWritable: true }], data: Buffer.alloc(24, 7) })]), /未允许的 Raydium/);
rejects('关闭别的仓位', tx([...cb, new TransactionInstruction({ programId: new PublicKey(C.CLMM), keys: [{ pubkey: owner, isSigner: true, isWritable: true }, { pubkey: evil, isSigner: false, isWritable: true }], data: disc('close_position') })]), /不是要撤的那个仓位/, { ...ctx, closePda: Keypair.generate().publicKey.toBase58() });
rejects('付款人是别人', tx([...cb, clmmIx('swap_v2', [], owner)], evil), /付款人不是你的钱包/);
rejects('陌生签名者', tx([...cb, clmmIx('swap_v2', [{ pubkey: evil, isSigner: true, isWritable: false }])]), /陌生的签名者/);
rejects('优先费过高', tx([ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000_000 }), clmmIx('swap_v2')]), /优先费过高/);
rejects('没有 Raydium 指令', tx([...cb]), /没有 Raydium/);
rejects('建账户但付款人不是你', tx([...cb, clmmIx('swap_v2'), SystemProgram.createAccount({ fromPubkey: evil, newAccountPubkey: Keypair.generate().publicKey, lamports: 1, space: 0, programId: new PublicKey(C.TOKEN) })]), /陌生的签名者|可疑/);

// 收紧后的检查
const nftMint = Keypair.generate();
const cctx = { ...ctx, extraSigners: [nftMint.publicKey.toBase58()] };
check(tx([...cb, SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: nftMint.publicKey, lamports: 3000000, space: 234, programId: new PublicKey(C.TOKEN22) }), clmmIx('open_position_with_token22_nft')]), cctx);
console.log('  通过 ✓ 建 NFT 账户（代币程序、押金小）');
rejects('建账户归属陌生程序', tx([...cb, clmmIx('swap_v2'), SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: nftMint.publicKey, lamports: 1000, space: 0, programId: evil })]), /代币程序/, cctx);
rejects('建账户押很多 SOL', tx([...cb, clmmIx('swap_v2'), SystemProgram.createAccount({ fromPubkey: owner, newAccountPubkey: nftMint.publicKey, lamports: 5e9, space: 0, programId: new PublicKey(C.TOKEN) })]), /SOL 太多/, cctx);
rejects('initAccount3 所有者是别人', tx([...cb, clmmIx('swap_v2'), spl.createInitializeAccount3Instruction(new PublicKey(evilAta), new PublicKey(C.MINT_B), evil)]), /所有者不是你/);
rejects('System Assign', tx([...cb, clmmIx('swap_v2'), SystemProgram.assign({ accountPubkey: owner, programId: evil })]), /未允许的系统指令/);

// 链接参数
const now = Math.floor(Date.now() / 1000);
const good = { id: 'abcdefghij', a: 'rebalance', k: 'withdraw', n: owner.toBase58(), w: O, c: now, e: now + 1800, pl: C.POOL_ID };
assert.ok(C.normalizeParams(C.decodeLink(C.encodeLink(good))));
assert.throws(() => C.normalizeParams({ ...good, pl: evil.toBase58() }), /池子/);
assert.throws(() => C.normalizeParams({ ...good, w: 'xx' }), /钱包/);
assert.throws(() => C.normalizeParams({ ...good, n: undefined }), /仓位/);
assert.throws(() => C.normalizeParams({ ...good, a: 'transfer' }), /操作类型/);
assert.throws(() => C.decodeLink(''), /缺少/);
assert.equal(C.linkCheck(C.normalizeParams(good), now + 1801).code, 'expired');
assert.equal(C.linkCheck(C.normalizeParams(good), now, evil.toBase58()).code, 'wallet');
assert.deepStrictEqual(C.stepsFor(C.normalizeParams(good)), ['withdraw', 'swap', 'open']);
assert.equal(C.normalizeParams({ ...good, r: 'https://evil.example.com' }).r, null, 'RPC from the link is ignored');
assert.equal(C.normalizeParams({ ...good, rf: 333.5, sp: 2 }).rf, 333.5);
assert.equal(C.normalizeParams(good).rf, 0);
assert.deepStrictEqual(C.stepsFor(C.normalizeParams({ ...good, k: 'swap' })), ['swap', 'open']);
assert.deepStrictEqual(C.stepsFor(C.normalizeParams({ ...good, a: 'open', k: 'open', n: null })), ['open']);
assert.deepStrictEqual(C.stepsFor(C.normalizeParams({ ...good, a: 'withdraw' })), ['withdraw']);
// 配平公式
const pl = C.planRebalance(337, 1, 0, { widthPct: 1, maxAmountUsd: 1000 });
assert.ok(Math.abs(pl.w - 0.4975) < 0.001 && pl.side === 'sell' && Math.abs(pl.delta - (337 - pl.w * 337)) < 1e-9);
console.log('guard test passed');
