import { strict as assert } from 'assert';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';

import { jsonInfo2PoolKeys } from '@raydium-io/raydium-sdk-v2';

import { rayIndex } from '../initRay.js';
import type { PoolEdge, SwapInstructionBundle } from '../graph/types.js';
import { isTradable, normMintA, normMintB } from '../ray/clmmIndex.js';
import { ensureAtaIx } from '../tokenAta.js';

const DEBUG = process.env.RAY_CLMM_DEBUG === '1';

type ClmmTools = {
  clmm: any;
  instrument: any;
};

const sdkModulePromise = import('@raydium-io/raydium-sdk-v2');
const clmmClientCache = new WeakMap<Connection, Promise<ClmmTools>>();

async function loadClmmTools(connection: Connection): Promise<ClmmTools> {
  let cached = clmmClientCache.get(connection);
  if (!cached) {
    cached = (async () => {
      const { Raydium, Clmm, Api, ClmmInstrument } = await sdkModulePromise;
      const api = new Api({ cluster: 'mainnet' });
      const raydium = new Raydium({ connection, api });
      const clmm = new Clmm({ scope: raydium, moduleName: 'Clmm' });
      return { clmm, instrument: ClmmInstrument };
    })();
    clmmClientCache.set(connection, cached);
  }
  return cached;
}

export function makeRayClmmEdge(
  connection: Connection,
  poolId: string,
  mintA: string,
  mintB: string,
): PoolEdge {
  const configuredId = new PublicKey(poolId).toBase58();
  const mintAPk = new PublicKey(mintA);
  const mintBPk = new PublicKey(mintB);

  let cachedPoolInfo: any | null = null;
  let cachedPoolKeys: any | null = null;

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

  async function loadPoolInfo(resolvedId: string): Promise<any> {
    if (cachedPoolInfo) return cachedPoolInfo;
    const { clmm } = await loadClmmTools(connection);
    const info = await clmm.getRpcClmmPoolInfo({ poolId: resolvedId });
    if (!info) {
      throw new Error(`raydium: failed to load pool info for ${resolvedId}`);
    }
    cachedPoolInfo = { ...info, id: resolvedId };
    return cachedPoolInfo;
  }

  async function loadPoolKeys(resolvedId: string): Promise<any> {
    if (cachedPoolKeys) return cachedPoolKeys;
    const { clmm } = await loadClmmTools(connection);
    const keys = await clmm.getClmmPoolKeys(resolvedId);
    if (!keys) {
      throw new Error(`raydium: failed to load pool keys for ${resolvedId}`);
    }
    cachedPoolKeys = keys;
    return cachedPoolKeys;
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
      amountIn: bigint,
      minOut: bigint,
      user: PublicKey,
    ): Promise<SwapInstructionBundle> {
      if (amountIn <= 0n) throw new Error('amountIn must be > 0');
      if (minOut < 0n) throw new Error('minOut must be >= 0');

      // Resolve a real, tradable Ray CLMM api item from our index
      const resolvedId = await resolvePoolId();
      const apiItem =
        rayIndex.getById(resolvedId) ||
        (await rayIndex.fetchByIdAndCache(resolvedId)) ||
        null;
      if (!apiItem) throw new Error(`raydium: api item missing for ${resolvedId}`);

      // Normalize to ClmmKeys the way ClmmInstrument expects
      const poolKeys = jsonInfo2PoolKeys(apiItem as any); // has .mintA/.mintB/.vault/.observationId as PublicKey
      const mintA = poolKeys.mintA.address; // PublicKey
      const mintB = poolKeys.mintB.address; // PublicKey

      // Direction from edge’s from/to mints
      const inputMintPk  = new PublicKey(this.from);
      const outputMintPk = new PublicKey(this.to);

      const direction =
        inputMintPk.equals(mintA) && outputMintPk.equals(mintB)
          ? 'AtoB'
          : inputMintPk.equals(mintB) && outputMintPk.equals(mintA)
          ? 'BtoA'
          : null;
      if (!direction) throw new Error('Input/output mint mismatch for Raydium CLMM pool');

      // Ensure ATAs strictly for pool mintA/mintB
      const setupIxs: TransactionInstruction[] = [];
      const ensureA = ensureAtaIx(user, user, mintA);
      const ensureB = ensureAtaIx(user, user, mintB);
      setupIxs.push(...ensureA.ixs, ...ensureB.ixs);

      // Owner info MUST be tokenAccountA/B (matching pool mintA/mintB)
      const ownerInfo = {
        wallet: user,
        tokenAccountA: ensureA.ata,
        tokenAccountB: ensureB.ata,
      };

      // Input mint for instrument (based on direction)
      const inputMint = direction === 'AtoB' ? mintA : mintB;

      const amountInBn = new BN(amountIn.toString());
      const minOutBn   = new BN(minOut.toString());

      // observationId from normalized keys (already a PublicKey)
      const observationId = poolKeys.observationId;

      // Optional debug to assert nothing is undefined
      console.debug('[RAY-CALL]', {
        poolId: resolvedId,
        wallet: user.toBase58(),
        mintA: mintA.toBase58(),
        mintB: mintB.toBase58(),
        tokenAccountA: ownerInfo.tokenAccountA.toBase58(),
        tokenAccountB: ownerInfo.tokenAccountB.toBase58(),
        inputMint: inputMint.toBase58(),
        amountIn: amountIn.toString(),
        minOut: minOut.toString(),
        observationId: observationId?.toBase58?.() ?? null,
        dir: direction,
      });

      // Build swap via instrument using normalized keys for both params
      const { instrument: ClmmInstrument } = await loadClmmTools(connection);
      const swapIxBundle = ClmmInstrument.makeSwapBaseInInstructions({
        poolInfo: poolKeys as any,
        poolKeys: poolKeys as any,
        ownerInfo,
        inputMint,
        amountIn: amountInBn,
        amountOutMin: minOutBn,
        observationId, // PublicKey
        // sqrtPriceLimitX64 / remainingAccounts optional
      });

      const rayIxs: TransactionInstruction[] = swapIxBundle?.instructions ?? [];
      return { ixs: [...setupIxs, ...rayIxs] };
    },
  };
}
