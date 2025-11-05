import { CFG } from './config.js';
import { makeConnections, getFreshBlockhash } from './rpc.js';
import { buildEdges } from './graph/builder.js';
import { findTriCandidates } from './graph/findTri.js';
import { bestSize } from './sizing.js';
import { startMetrics, cBundlesOk, cBundlesSent, cSimFail, cExecFail, gIncludeRatio, gPriorityFee, cScansTotal } from './metrics.js';
import { Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';

async function getFreshHashSafe(read: any, send: any) {
  try { return await send.getLatestBlockhash('processed'); }
  catch (e) {
    console.warn('[blockhash] SEND RPC failed, fallback to READ:', (e as any)?.message ?? e);
    return await read.getLatestBlockhash('processed');
  }
}

async function main() {
  if (!CFG.walletSecret) throw new Error('WALLET_SECRET missing');

  startMetrics();

  const heartbeat = setInterval(() => {
    console.log(`[loop] heartbeat ${new Date().toISOString()}`);
  }, CFG.scanIntervalMs ?? 2000);
  heartbeat.unref?.();

  const { read: readConn, send: sendConn } = makeConnections();
  const wallet = Keypair.fromSecretKey(bs58.decode(CFG.walletSecret));

  // Build edges and set up WS subs inside builder
  const edges = await buildEdges();
  console.log(`[init] edges=${edges.length}, tokens=${CFG.tokensUniverse.length}`);

  // Jito BE client (public mode; no auth key)
  const jito = searcherClient(CFG.jitoUrl as any, undefined as any);
  const tipList: any = await jito.getTipAccounts().catch(() => ([]));
  const tipAccount = tipList?.[0] ? new PublicKey(tipList[0]) : null;

  let priorityFee = CFG.priorityFeeMin;
  let sent = 0, ok = 0, consecutiveFails = 0;

  function tuneFee() {
    const ratio = sent ? ok / sent : 0;
    gIncludeRatio.set(ratio);
    if (ratio < CFG.includeRatioTarget && priorityFee < CFG.priorityFeeMax) priorityFee += CFG.feeAdjStep;
    if (ratio > CFG.includeRatioTarget && priorityFee > CFG.priorityFeeMin) priorityFee -= CFG.feeAdjStep;
    if (priorityFee < CFG.priorityFeeMin) priorityFee = CFG.priorityFeeMin;
    if (priorityFee > CFG.priorityFeeMax) priorityFee = CFG.priorityFeeMax;
    gPriorityFee.set(priorityFee);
  }

  async function sendViaBundle(vtx: VersionedTransaction) {
    // Simple bundle with a single tx; you can add a separate “tip tx” later
    const { Bundle } = await import('jito-ts/dist/sdk/block-engine/types.js');
    const { isError } = await import('jito-ts/dist/sdk/block-engine/utils.js');
    const b = new Bundle([], 3);
    const res = (b as any).addSignedTransactions(vtx);
    if (isError(res)) throw res;
    return jito.sendBundle(b);
  }

  while (true) {
    try {
      console.log(`[loop] tick ${new Date().toISOString()}`);
      cScansTotal.inc();
      console.log('[scan] start');
      console.log(`[scan] edges=${edges.length}`);
      const seed = CFG.sizeLadder[0]; // seed for candidate scan
      console.log(`[scan] building candidates with seed=${seed}`);
      const candidates = await findTriCandidates(edges, seed);
      console.log(`[scan] candidates=${candidates.length}`);

      for (const path of candidates) {
        const sized = await bestSize(path, CFG.sizeLadder);
        if (!sized) continue;

        const routeId = path.map(e => e.id).join(' -> ');
        console.log(`[scan] evaluating route ${routeId}`);

        let q1: bigint;
        try {
          console.log(`[quote] via ${path[0].id} amountIn=${sized.inAmount}`);
          q1 = await path[0].quoteOut(sized.inAmount);
          if (q1 <= 0n) {
            console.warn(`[quote] ${path[0].id} returned ${q1} for ${sized.inAmount}`);
            continue;
          }
        } catch (e) {
          console.warn(`[quote] ${path[0].id} failed:`, (e as Error)?.message ?? e);
          continue;
        }

        let q2: bigint;
        try {
          console.log(`[quote] via ${path[1].id} amountIn=${q1}`);
          q2 = await path[1].quoteOut(q1);
          if (q2 <= 0n) {
            console.warn(`[quote] ${path[1].id} returned ${q2} for ${q1}`);
            continue;
          }
        } catch (e) {
          console.warn(`[quote] ${path[1].id} failed:`, (e as Error)?.message ?? e);
          continue;
        }

        let q3: bigint;
        try {
          console.log(`[quote] via ${path[2].id} amountIn=${q2}`);
          q3 = await path[2].quoteOut(q2);
          if (q3 <= 0n) {
            console.warn(`[quote] ${path[2].id} returned ${q3} for ${q2}`);
            continue;
          }
        } catch (e) {
          console.warn(`[quote] ${path[2].id} failed:`, (e as Error)?.message ?? e);
          continue;
        }

        const pnl = q3 - sized.inAmount;
        const pnlBps = sized.inAmount > 0n ? Number((pnl * 10_000n) / sized.inAmount) : 0;
        console.log(`[sim] route=${routeId} expectedOut=${q3} pnlBps=${pnlBps}`);

        if (q3 <= sized.inAmount) continue;

        console.log('[send] building tx...');
        const ix1 = await path[0].buildSwapIx(sized.inAmount, q1, wallet.publicKey);
        const ix2 = await path[1].buildSwapIx(q1, q2, wallet.publicKey);
        const ix3 = await path[2].buildSwapIx(q2, q3, wallet.publicKey);

        const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 });
        const feeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee });

        const { blockhash, lastValidBlockHeight } = await getFreshHashSafe(readConn, sendConn);
        const msg = new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: blockhash,
          instructions: [cuIx, feeIx, ...ix1, ...ix2, ...ix3]
        }).compileToV0Message();

        const vtx = new VersionedTransaction(msg);
        vtx.sign([wallet]);

        // Simulate exact tx
        console.log('[sim] simulating tx...');
        const sim = await readConn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: false });
        const simOk = !sim.value.err;
        if (!simOk) {
          cSimFail.inc(); consecutiveFails++;
          if (CFG.haltOnNegativeSim) continue;
        }

        try {
          cBundlesSent.inc(); sent++;
          const id = await sendViaBundle(vtx);
          console.log('[send] submitted bundle...', id ?? '(no id)');
          if (id) { cBundlesOk.inc(); ok++; consecutiveFails = 0; }
          else { cExecFail.inc(); consecutiveFails++; }
        } catch (e) {
          console.error('[bundle/send] error', e);
          cExecFail.inc(); consecutiveFails++;
        }

        tuneFee();
        if (consecutiveFails >= CFG.maxConsecutiveFails) {
          console.error(`[risk] ${consecutiveFails} consecutive fails → cooldown`);
          await new Promise(r => setTimeout(r, 5000));
          consecutiveFails = 0;
        }
      }

      await new Promise(r => setTimeout(r, CFG.cooldownMs));
    } catch (e) {
      console.error('[loop]', e);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

main().catch(console.error);

