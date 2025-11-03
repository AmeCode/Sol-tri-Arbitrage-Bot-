import { CFG } from './config.js';
import { makeConnections } from './rpc.js';
import { buildEdges } from './graph/builder.js';
import { findTriCandidates } from './graph/findTri.js';
import { bestSize } from './sizing.js';
import { startMetrics, cBundlesOk, cBundlesSent, cSimFail, cExecFail, gIncludeRatio, gPriorityFee } from './metrics.js';
import { Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
async function getFreshHashSafe(read, send) {
    try {
        return await send.getLatestBlockhash('processed');
    }
    catch (e) {
        console.warn('[blockhash] SEND RPC failed, fallback to READ:', e?.message ?? e);
        return await read.getLatestBlockhash('processed');
    }
}
async function main() {
    if (!CFG.walletSecret)
        throw new Error('WALLET_SECRET missing');
    startMetrics();
    const { read: readConn, send: sendConn } = makeConnections();
    const wallet = Keypair.fromSecretKey(bs58.decode(CFG.walletSecret));
    // Build edges and set up WS subs inside builder
    const edges = await buildEdges();
    console.log(`[init] edges=${edges.length}, tokens=${CFG.tokensUniverse.length}`);
    // Jito BE client (public mode; no auth key)
    const jito = searcherClient(CFG.jitoUrl, undefined);
    const tipList = await jito.getTipAccounts().catch(() => ([]));
    const tipAccount = tipList?.[0] ? new PublicKey(tipList[0]) : null;
    let priorityFee = CFG.priorityFeeMin;
    let sent = 0, ok = 0, consecutiveFails = 0;
    function tuneFee() {
        const ratio = sent ? ok / sent : 0;
        gIncludeRatio.set(ratio);
        if (ratio < CFG.includeRatioTarget && priorityFee < CFG.priorityFeeMax)
            priorityFee += CFG.feeAdjStep;
        if (ratio > CFG.includeRatioTarget && priorityFee > CFG.priorityFeeMin)
            priorityFee -= CFG.feeAdjStep;
        if (priorityFee < CFG.priorityFeeMin)
            priorityFee = CFG.priorityFeeMin;
        if (priorityFee > CFG.priorityFeeMax)
            priorityFee = CFG.priorityFeeMax;
        gPriorityFee.set(priorityFee);
    }
    async function sendViaBundle(vtx) {
        // Simple bundle with a single tx; you can add a separate “tip tx” later
        const { Bundle } = await import('jito-ts/dist/sdk/block-engine/types.js');
        const { isError } = await import('jito-ts/dist/sdk/block-engine/utils.js');
        const b = new Bundle([], 3);
        const res = b.addSignedTransactions(vtx);
        if (isError(res))
            throw res;
        return jito.sendBundle(b);
    }
    while (true) {
        try {
            const seed = CFG.sizeLadder[0]; // seed for candidate scan
            const candidates = await findTriCandidates(edges, seed);
            for (const path of candidates) {
                const sized = await bestSize(path, CFG.sizeLadder);
                if (!sized)
                    continue;
                const q1 = await path[0].quoteOut(sized.inAmount);
                const q2 = await path[1].quoteOut(q1);
                const q3 = await path[2].quoteOut(q2);
                if (q3 <= sized.inAmount)
                    continue;
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
                const sim = await readConn.simulateTransaction(vtx, { sigVerify: false, replaceRecentBlockhash: false });
                const simOk = !sim.value.err;
                if (!simOk) {
                    cSimFail.inc();
                    consecutiveFails++;
                    if (CFG.haltOnNegativeSim)
                        continue;
                }
                try {
                    cBundlesSent.inc();
                    sent++;
                    const id = await sendViaBundle(vtx);
                    if (id) {
                        cBundlesOk.inc();
                        ok++;
                        consecutiveFails = 0;
                    }
                    else {
                        cExecFail.inc();
                        consecutiveFails++;
                    }
                }
                catch (e) {
                    console.error('[bundle/send] error', e);
                    cExecFail.inc();
                    consecutiveFails++;
                }
                tuneFee();
                if (consecutiveFails >= CFG.maxConsecutiveFails) {
                    console.error(`[risk] ${consecutiveFails} consecutive fails → cooldown`);
                    await new Promise(r => setTimeout(r, 5000));
                    consecutiveFails = 0;
                }
            }
            await new Promise(r => setTimeout(r, CFG.cooldownMs));
        }
        catch (e) {
            console.error('[loop]', e);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}
main().catch(console.error);
//# sourceMappingURL=index.js.map