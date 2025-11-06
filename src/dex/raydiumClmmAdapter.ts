import { PublicKey } from '@solana/web3.js';
import { rayIndex } from '../initRay.js';
import type { PoolEdge, SwapInstructionBundle } from '../graph/types.js';
import { isTradable, normMintA, normMintB } from '../ray/clmmIndex.js';

export function makeRayClmmEdge(poolId: string, mintA: string, mintB: string): PoolEdge {
  const configuredId = new PublicKey(poolId).toBase58();

  async function resolvePoolId(): Promise<string> {
    // direct hit?
    let p = rayIndex.getById(configuredId);
    if (!p) p = await rayIndex.fetchByIdAndCache(configuredId);

    if (!p) {
      // try by mints (auto-correct misconfigured IDs)
      const pairId = rayIndex.findByMints(mintA, mintB);
      let pairPool = pairId ? rayIndex.getById(pairId) : undefined;
      if (!pairPool) {
        pairPool = (await rayIndex.fetchByMintsAndCache(mintA, mintB))
          ?? (await rayIndex.fetchByMintsAndCache(mintB, mintA));
      }

      if (!pairPool) {
        console.warn('[ray-edge] miss', {
          id: configuredId,
          debug: `[ray-index] miss for ${configuredId}`,
          note: 'ensure pool id exists in Ray CLMM API'
        });
        throw new Error(`raydium: api pool not found for ${configuredId}`);
      }

      const resolvedId = (pairPool.id || pairPool.pool_id)?.toString();
      if (!resolvedId) {
        throw new Error(`raydium: api pool missing identifier for ${configuredId}`);
      }

      if (resolvedId !== configuredId) {
        console.warn('[ray-edge] replacing configured pool id with API pair result', {
          configured: configuredId, resolved: resolvedId, pair: `${mintA}-${mintB}`
        });
      }
      p = rayIndex.getById(resolvedId)!;
    }

    // refuse locked / untradable pools
    if (!isTradable(p)) {
      const a = normMintA(p) ?? mintA;
      const b = normMintB(p) ?? mintB;
      console.warn('[ray-edge] skip locked/untradable pool', {
        id: configuredId,
        status: p.status || p.state,
        liquidity: p.liquidity,
        tvl: p.tvlUsd ?? p.tvl_usd ?? p.tvl
      });
      throw new Error('raydium: pool locked or no liquidity');
    }

    return (p.id || p.pool_id)!;
  }

  return {
    id: `ray:${configuredId}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    async quoteOut(amountIn: bigint): Promise<bigint> {
      // Resolve or fail fast with clear message
      await resolvePoolId();

      // TODO: replace with proper SDK quote.
      if (amountIn <= 0n) throw new Error('raydium: non-positive amountIn');
      return amountIn;
    },

    async buildSwapIx(
      _amountIn: bigint,
      _minOut: bigint,
      _user: PublicKey,
    ): Promise<SwapInstructionBundle> {
      const id = await resolvePoolId();
      throw new Error(`raydium: buildSwapIx not implemented for ${id}`);
    }
  };
}
