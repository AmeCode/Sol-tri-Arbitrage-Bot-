import { strict as assert } from 'assert';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';

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

  const id = await resolvePoolId();
  const poolInfo = await loadPoolInfo(id);
  const poolKeys = await loadPoolKeys(id);
  const { instrument } = await loadClmmTools(connection);

  // Coerce pool mints to PublicKey
  const mintA = new PublicKey(poolInfo.mintA.address ?? poolInfo.mintA);
  const mintB = new PublicKey(poolInfo.mintB.address ?? poolInfo.mintB);

  const inputMintPk  = new PublicKey(this.from);
  const outputMintPk = new PublicKey(this.to);

  // Figure out direction and which ATA is "in" / "out"
  const direction =
    inputMintPk.equals(mintA) && outputMintPk.equals(mintB)
      ? 'AtoB'
      : inputMintPk.equals(mintB) && outputMintPk.equals(mintA)
      ? 'BtoA'
      : null;

  if (!direction) {
    throw new Error('Input/output mint mismatch for Raydium CLMM pool');
  }

  // Ensure ATAs for both mints
  const setupIxs: TransactionInstruction[] = [];
  const ensureA = ensureAtaIx(user, user, mintA);
  const ensureB = ensureAtaIx(user, user, mintB);
  setupIxs.push(...ensureA.ixs, ...ensureB.ixs);

  const ataA = ensureA.ata; // ATA for mintA
  const ataB = ensureB.ata; // ATA for mintB

  // Map to tokenAccountIn/out based on direction
  const tokenAccountIn  = direction === 'AtoB' ? ataA : ataB;
  const tokenAccountOut = direction === 'AtoB' ? ataB : ataA;

  // Owner info in the exact shape instrument expects
  const ownerInfo = {
    wallet: user,
    tokenAccountIn,
    tokenAccountOut,
  };

  // Input mint for the SDK call
  const inputMint = direction === 'AtoB' ? mintA : mintB;

  const amountInBn = new BN(amountIn.toString());
  const minOutBn   = new BN(minOut.toString());

  // observationId: ensure it’s a PublicKey if present; otherwise omit
  let observationIdPk: PublicKey | undefined;
  const rawObs =
    poolKeys?.observationId ??
    poolInfo?.observationId ??
    poolInfo?.observationIdKey ??
    null;

  if (rawObs) {
    observationIdPk = new PublicKey(
      typeof rawObs === 'string' ? rawObs : (rawObs as PublicKey),
    );
  }

  // Build swap ixs via Raydium v2 instrument
  const swapIxBundle = instrument.makeSwapBaseInInstructions({
    poolInfo,
    poolKeys,
    ownerInfo,
    inputMint,
    amountIn: amountInBn,
    amountOutMin: minOutBn,
    // omit sqrtPriceLimitX64 / remainingAccounts unless you really need them
    ...(observationIdPk ? { observationId: observationIdPk } : {}),
  });

  const rayIxs: TransactionInstruction[] = swapIxBundle?.instructions ?? [];

  if (DEBUG) {
    console.debug('[RayCLMM] buildSwapIx', {
      pool: poolInfo.id?.toString?.() ?? id,
      dir: direction,
      amountIn: amountIn.toString(),
      minOut: minOut.toString(),
      tokenAccountIn: tokenAccountIn.toBase58(),
      tokenAccountOut: tokenAccountOut.toBase58(),
      obs: observationIdPk?.toBase58() ?? null,
      ixCount: rayIxs.length,
    });
  }

      return { ixs: [...setupIxs, ...rayIxs] };
    }
  };
}
