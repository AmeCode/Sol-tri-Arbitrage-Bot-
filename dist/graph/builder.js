import { PublicKey } from '@solana/web3.js';
import { CFG } from '../config.js';
import { makeConnections } from '../rpc.js';
// Use the util/wsCache file instead of a non-existent utils directory.
import { WsAccountCache } from '../util/wsCache.js';
import { initOrcaCtx, makeOrcaEdge } from '../dex/orcaWhirlpoolAdapter.js';
import { makeRayClmmEdge } from '../dex/raydiumClmmAdapter.js';
import { makeMeteoraEdge } from '../dex/meteoraDlmmAdapter.js';
import { canonicalMint, WSOL_MINT } from '../util/mints.js';
const MINTS = {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
};
export async function buildEdges() {
    const { read } = makeConnections();
    const cache = new WsAccountCache(read);
    // Wallet pubkey is only needed by Orca SDK context (dummy signer ok)
    const dummyWallet = new PublicKey(WSOL_MINT); // any 32B pk works; real payer signs in index.ts
    const orcaCtx = initOrcaCtx(read, dummyWallet);
    const edges = [];
    // ---- Orca Whirlpools (subscribe to pool accounts) ----
    const orcaPools = [
        { id: CFG.pools.orca.solUsdc, a: MINTS.SOL, b: MINTS.USDC },
        { id: CFG.pools.orca.msolSol, a: MINTS.MSOL, b: MINTS.SOL },
        { id: CFG.pools.orca.solUsdt, a: MINTS.SOL, b: MINTS.USDT }
    ].filter(p => p.id);
    for (const p of orcaPools) {
        const poolPk = new PublicKey(p.id);
        cache.subscribe(poolPk);
        const fromMint = canonicalMint(p.a);
        const toMint = canonicalMint(p.b);
        edges.push({ ...makeOrcaEdge(p.id, fromMint, toMint, orcaCtx), from: fromMint, to: toMint }, { ...makeOrcaEdge(p.id, fromMint, toMint, orcaCtx), from: toMint, to: fromMint });
    }
    // ---- Raydium CLMM ----
    const rayPools = [
        { id: CFG.pools.ray.solUsdc, a: MINTS.SOL, b: MINTS.USDC },
        { id: CFG.pools.ray.bonkUsdc, a: MINTS.BONK, b: MINTS.USDC },
        { id: CFG.pools.ray.jupUsdc, a: MINTS.JUP, b: MINTS.USDC }
    ].filter(p => p.id);
    for (const p of rayPools) {
        const fromMint = canonicalMint(p.a);
        const toMint = canonicalMint(p.b);
        edges.push({ ...makeRayClmmEdge(p.id, fromMint, toMint, read), from: fromMint, to: toMint }, { ...makeRayClmmEdge(p.id, fromMint, toMint, read), from: toMint, to: fromMint });
    }
    // ---- Meteora DLMM (Micro-liquidity bins) ----
    const dlmms = [
        { id: CFG.pools.meteora.solUsdc, a: MINTS.SOL, b: MINTS.USDC },
        { id: CFG.pools.meteora.bonkUsdc, a: MINTS.BONK, b: MINTS.USDC },
        { id: CFG.pools.meteora.jupUsdc, a: MINTS.JUP, b: MINTS.USDC }
    ].filter(p => p.id);
    for (const p of dlmms) {
        const fromMint = canonicalMint(p.a);
        const toMint = canonicalMint(p.b);
        edges.push({ ...makeMeteoraEdge(p.id, fromMint, toMint), from: fromMint, to: toMint }, { ...makeMeteoraEdge(p.id, toMint, fromMint), from: toMint, to: fromMint });
    }
    const byPair = new Map();
    for (const e of edges) {
        const k = `${e.from}|${e.to}`;
        byPair.set(k, (byPair.get(k) ?? 0) + 1);
    }
    const samplePairs = [...byPair.entries()].slice(0, 10);
    console.log(`[builder] orca=${orcaPools.length}, ray=${rayPools.length}, meteora=${dlmms.length} pools; edges=${edges.length}`);
    console.log('[builder] directed edges per pair sample=', samplePairs);
    return edges;
}
//# sourceMappingURL=builder.js.map