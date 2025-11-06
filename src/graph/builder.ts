import { PublicKey } from '@solana/web3.js';
import { PoolEdge } from './types.js';
import { CFG } from '../config.js';
import { makeConnections } from '../rpc.js';
// Use the util/wsCache file instead of a non-existent utils directory.
import { WsAccountCache } from '../util/wsCache.js';
import { initOrcaCtx, makeOrcaEdge } from '../dex/orcaWhirlpoolAdapter.js';
import { makeRayClmmEdge } from '../dex/raydiumClmmAdapter.js';
import { makeMeteoraEdge } from '../dex/meteoraDlmmAdapter.js';
import { canonicalMint, WSOL_MINT } from '../util/mints.js';
import { loadRayIndexOnce, rayIndex } from '../initRay.js';
import { isTradable } from '../ray/clmmIndex.js';

console.log('[cfg] pools.orca', CFG.pools.orca);
console.log('[cfg] pools.ray', CFG.pools.ray);
console.log('[cfg] pools.meteora', CFG.pools.meteora);
console.log('[cfg] tokens', CFG.tokensUniverse);

const MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  JUP:  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  MSOL: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'
};

function mintForSymbol(symbol: string, envKey: string): string {
  const normalized = symbol?.trim().toUpperCase();
  if (!normalized) {
    throw new Error(`[builder] token symbol missing for ${envKey}`);
  }
  const mint = (MINTS as Record<string, string>)[normalized];
  if (!mint) {
    throw new Error(`[builder] no mint mapping for ${normalized} (from ${envKey})`);
  }
  return mint;
}

export async function buildEdges(): Promise<PoolEdge[]> {
  const { read: readConn } = makeConnections();
  const cache = new WsAccountCache(readConn);

  await loadRayIndexOnce();

  // Wallet pubkey is only needed by Orca SDK context (dummy signer ok)
  const dummyWallet = new PublicKey(WSOL_MINT); // any 32B pk works; real payer signs in index.ts
  const orcaCtx = initOrcaCtx(readConn, dummyWallet);

  const edges: PoolEdge[] = [];

  // ---- Orca Whirlpools (subscribe to pool accounts) ----
  const orcaPools = CFG.pools.orca;

  for (const p of orcaPools) {
    const poolPk = new PublicKey(p.id);
    cache.subscribe(poolPk);
    const fromMint = canonicalMint(mintForSymbol(p.a, p.key));
    const toMint = canonicalMint(mintForSymbol(p.b, p.key));
    edges.push(
      { ...makeOrcaEdge(p.id, fromMint, toMint, orcaCtx), from: fromMint, to: toMint },
      { ...makeOrcaEdge(p.id, fromMint, toMint, orcaCtx), from: toMint, to: fromMint }
    );
  }

  // ---- Raydium CLMM ----
  const rayPools = CFG.pools.ray;
  const filteredRayPools: typeof rayPools = [];
  for (const p of rayPools) {
    const id = new PublicKey(p.id).toBase58();
    const apiPool = rayIndex.getById(id) ?? await rayIndex.fetchByIdAndCache(id);
    if (!apiPool) {
      console.warn('[boot] Ray pool not found in API (will auto-recover by mints at runtime)', { id });
      filteredRayPools.push(p);
      continue;
    }
    if (!isTradable(apiPool)) {
      console.warn('[boot] drop locked/untradable Ray pool', {
        id,
        status: apiPool.status || apiPool.state,
        liq: apiPool.liquidity,
        tvl: apiPool.tvlUsd ?? apiPool.tvl_usd ?? apiPool.tvl,
      });
      continue;
    }
    filteredRayPools.push(p);
  }

  for (const p of filteredRayPools) {
    const fromMint = canonicalMint(mintForSymbol(p.a, p.key));
    const toMint = canonicalMint(mintForSymbol(p.b, p.key));
    edges.push(
      { ...makeRayClmmEdge(p.id, fromMint, toMint), from: fromMint, to: toMint },
      { ...makeRayClmmEdge(p.id, fromMint, toMint), from: toMint, to: fromMint }
    );
  }

  // ---- Meteora DLMM (Micro-liquidity bins) ----
  const dlmms = CFG.pools.meteora;

  for (const p of dlmms) {
    const fromMint = canonicalMint(mintForSymbol(p.a, p.key));
    const toMint = canonicalMint(mintForSymbol(p.b, p.key));
    edges.push(
      makeMeteoraEdge(readConn, p.id, fromMint, toMint),
      makeMeteoraEdge(readConn, p.id, toMint, fromMint),
    );
  }

  const byPair = new Map<string, number>();
  for (const e of edges) {
    const k = `${e.from}|${e.to}`;
    byPair.set(k, (byPair.get(k) ?? 0) + 1);
  }

  const samplePairs = [...byPair.entries()].slice(0, 10);

  console.log(`[builder] orca=${orcaPools.length}, ray=${filteredRayPools.length}, meteora=${dlmms.length} pools; edges=${edges.length}`);
  console.log('[builder] directed edges per pair sample=', samplePairs);
  return edges;
}

