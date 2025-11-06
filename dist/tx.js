import { ComputeBudgetProgram, PublicKey, Transaction, TransactionMessage, VersionedTransaction, } from '@solana/web3.js';
import { CFG } from './config.js';
import { ensureLutHas } from './lut.js';
import { assertNoUnwhitelistedAllocations } from './txGuards.js';
import { sanitizeWithSignerWhitelist } from './txSanitize.js';
let runtimeLutAddress = CFG.lutAddressEnv && CFG.lutAddressEnv.length > 0
    ? new PublicKey(CFG.lutAddressEnv)
    : null;
export function getRuntimeLutAddress() {
    return runtimeLutAddress;
}
export function setRuntimeLutAddress(addr) {
    runtimeLutAddress = addr;
}
export function withComputeBudget(ixs, cuLimit, cuPriceMicroLamports) {
    const pre = [];
    if (cuLimit && cuLimit > 0) {
        pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    }
    if (cuPriceMicroLamports && cuPriceMicroLamports > 0) {
        pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }));
    }
    return [...pre, ...ixs];
}
export async function buildAndMaybeLut(connection, payer, payerSigner, // Keypair
rawInstructions, cuPriceMicroLamports, cuLimit, extraSignerPubkeys = []) {
    // 0) Guard BEFORE sanitize so errors point at the offending ix clearly
    const allowed = new Set(extraSignerPubkeys.map(k => k.toBase58()));
    assertNoUnwhitelistedAllocations(rawInstructions, payer, allowed);
    const sanitized = sanitizeWithSignerWhitelist(rawInstructions, payer, allowed);
    const withCb = withComputeBudget(sanitized, cuLimit ?? CFG.cuLimit, cuPriceMicroLamports);
    // 1) Try legacy first (fast path)
    try {
        const { blockhash } = await connection.getLatestBlockhash();
        const legacy = new Transaction();
        legacy.recentBlockhash = blockhash;
        legacy.feePayer = payer;
        withCb.forEach(ix => legacy.add(ix));
        // serialize to ensure it fits; if too large, fallthrough to v0/LUT
        legacy.serialize({ requireAllSignatures: false, verifySignatures: false });
        return { kind: 'legacy', tx: legacy };
    }
    catch {
        // too big → build v0 with LUT
    }
    // 2) v0 with LUT (collect all accounts)
    const keySet = new Set();
    const requiredKeys = [];
    function add(k) {
        const s = k.toBase58();
        if (!keySet.has(s)) {
            keySet.add(s);
            requiredKeys.push(k);
        }
    }
    for (const ix of withCb) {
        add(ix.programId);
        for (const k of ix.keys)
            add(k.pubkey);
    }
    const ensured = await ensureLutHas(connection, payer, payerSigner, runtimeLutAddress, requiredKeys);
    runtimeLutAddress = ensured;
    // Compile v0
    const lutAcc = (await connection.getAddressLookupTable(ensured)).value;
    if (!lutAcc)
        throw new Error('LUT not found on chain');
    const { blockhash } = await connection.getLatestBlockhash();
    const msg = new TransactionMessage({
        payerKey: payer,
        recentBlockhash: blockhash,
        instructions: withCb,
    }).compileToV0Message([lutAcc]);
    return { kind: 'v0', tx: new VersionedTransaction(msg), lutAddressUsed: ensured };
}
//# sourceMappingURL=tx.js.map