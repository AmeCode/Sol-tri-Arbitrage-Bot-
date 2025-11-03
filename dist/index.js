import { CFG } from './config.js';
import { makeConnections, getFreshBlockhash } from './rpc.js';
import { buildEdges } from './graph/builder.js';
import { findTriCandidates } from './graph/findTri.js';
import { bestSize } from './sizing.js';
import { jitoClient, simulateBundle, sendBundle } from './jito.js';
import { startMetrics, cBundlesOk, cBundlesSent, cSimFail, cExecFail, gIncludeRatio, gPriorityFee } from './metrics.js';
import { Keypair, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import bs58 from 'bs58';
async function main() {
    if (!CFG.walletSecret)
        throw new Error('WALLET_SECRET missing');
    if (!CFG.rpcRead || !CFG.rpcSend)
        throw new Error('RPC_URL_READ / RPC_URL_SEND missing');
    startMetrics();
    const { read: readConn, send: sendConn } = makeConnections();
    const wallet = Keypair.fromSecretKey(bs58.decode(CFG.walletSecret));
    const edges = await buildEdges();
    console.log(`[init] using ${edges.length} edges, tokens=${CFG.tokensUniverse.length}`);
    const jito = jitoClient(CFG.jitoRpc);
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
    while (true) {
        try {
            // DISCOVERY (READ RPC only)
            const candidates = await findTriCandidates(edges, CFG.seedInBase);
            for (const path of candidates) {
                // SIZE SELECTION (READ RPC only)
                const sized = await bestSize(path, CFG.sizeLadder);
                if (!sized)
                    continue;
                // BUILD IXs with fresh quotes (READ path via Jupiter HTTP)
                const q1 = await path[0].quoteOut(sized.inAmount);
                const q2 = await path[1].quoteOut(q1);
                const q3 = await path[2].quoteOut(q2);
                if (q3 <= sized.inAmount)
                    continue; // not profitable after re-check
                const ix1 = await path[0].buildSwapIx(sized.inAmount, q1, wallet.publicKey);
                const ix2 = await path[1].buildSwapIx(q1, q2, wallet.publicKey);
                const ix3 = await path[2].buildSwapIx(q2, q3, wallet.publicKey);
                // COMPUTE + PRIORITY FEE (applies on SEND side)
                const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_200_000 });
                const feeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee });
                // Fresh blockhash from SEND RPC
                const blockhash = await getFreshBlockhash(sendConn);
                const msg = new TransactionMessage({
                    payerKey: wallet.publicKey,
                    recentBlockhash: blockhash,
                    instructions: [cuIx, feeIx, ...ix1, ...ix2, ...ix3]
                }).compileToV0Message();
                const vtx = new VersionedTransaction(msg);
                vtx.sign([wallet]);
                const base64 = Buffer.from(vtx.serialize()).toString('base64');
                // SIMULATE + SEND via Jito (SEND path)
                let simOk = false;
                try {
                    const sim = await simulateBundle(jito, [base64]);
                    simOk = !!sim && !sim.error && (!sim.result || !sim.result.err);
                }
                catch {
                    simOk = false;
                }
                if (!simOk) {
                    cSimFail.inc();
                    consecutiveFails++;
                    if (CFG.haltOnNegativeSim)
                        continue;
                }
                try {
                    cBundlesSent.inc();
                    sent++;
                    const out = await sendBundle(jito, [base64]);
                    if (out && !out.error) {
                        cBundlesOk.inc();
                        ok++;
                        consecutiveFails = 0;
                    }
                    else {
                        cExecFail.inc();
                        consecutiveFails++;
                    }
                }
                catch {
                    cExecFail.inc();
                    consecutiveFails++;
                }
                tuneFee();
                if (consecutiveFails >= CFG.maxConsecutiveFails) {
                    console.error(`[risk] ${consecutiveFails} fails → cool down`);
                    await new Promise(r => setTimeout(r, 5_000));
                    consecutiveFails = 0;
                }
            }
            await new Promise(r => setTimeout(r, CFG.cooldownMs));
        }
        catch (e) {
            console.error(`[loop]`, e);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}
main().catch(console.error);
//# sourceMappingURL=index.js.map