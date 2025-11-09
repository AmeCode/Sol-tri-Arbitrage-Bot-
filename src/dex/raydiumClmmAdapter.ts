// src/dex/raydiumClmmAdapter.ts
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import {
  MIN_SQRT_PRICE_X64,
  MAX_SQRT_PRICE_X64,
  ONE,
} from '@raydium-io/raydium-sdk-v2';

import { rayIndex } from '../initRay.js';
import type { PoolEdge, SwapInstructionBundle } from '../graph/types.js';
import { isTradable } from '../ray/clmmIndex.js';
import { ensureAtaIx } from '../tokenAta.js';
import { mustAccount } from '../onchain/assertions.js';
import { AccountLayout } from '@solana/spl-token';
import { DexEdge, Quote, BuildIxResult } from './types.js';
import { IS_SIM } from '../runtime.js';
import { PoolUtils } from '@raydium-io/raydium-sdk-v2';

// We import these types only to annotate shapes clearly
// (no runtime import)
type ApiClmmConfigV3 = {
  id: string;
  [k: string]: unknown;
};
type ApiV3PoolInfoConcentratedItem = {
  id: string;
  programId: string;
  type: 'Concentrated';
  mintA: { address: string };
  mintB: { address: string };
  config: ApiClmmConfigV3;
};
type ClmmKeys = {
  id: string;
  programId: string;
  mintA: { address: string };
  mintB: { address: string };
  vault: { A: string; B: string };
  observationId: string;
  lookupTableAccount?: string;
  config: ApiClmmConfigV3;
  [k: string]: unknown;
};

type BNType = InstanceType<typeof BN>;

const DEBUG = process.env.RAY_CLMM_DEBUG === '1';
const DEFAULT_SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? '50');

function toBN(value: BNType | bigint): BNType {
  return BN.isBN(value) ? (value as BNType) : new BN(value.toString());
}

async function ensureAtaPresent(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  label: string,
): Promise<PublicKey> {
  const ensured = ensureAtaIx(owner, owner, mint);
  if (ensured.ixs.length) {
    throw new Error(
      `${label}: missing ATA ${ensured.ata.toBase58()} — run scripts/one_time_setup.ts to create it once`,
    );
  }
  await mustAccount(connection, ensured.ata, label);
  return ensured.ata;
}

async function assertInputBalance(
  connection: Connection,
  ata: PublicKey,
  amount: BNType,
  label: string,
) {
  const info = await mustAccount(connection, ata, label);
  const decoded = AccountLayout.decode(info.data);
  const available = BigInt(decoded.amount.toString());
  if (available < BigInt(amount.toString())) {
    throw new Error(
      `${label}: ${ata.toBase58()} has ${available} but needs ${amount.toString()} — top up before trading`,
    );
  }
}

/* -------------------------------- helpers -------------------------------- */

function mustPk(v: string | PublicKey | undefined, label: string): PublicKey {
  if (!v) throw new Error(`raydium: ${label} missing`);
  try {
    // @ts-ignore
    return new PublicKey(v);
  } catch {
    throw new Error(`raydium: ${label} invalid: ${String(v)}`);
  }
}

async function fetchApiPoolById(id: string): Promise<any | null> {
  const url = `https://api-v3.raydium.io/pools/info/ids?ids=${encodeURIComponent(id)}`;
  let res: Response | null = null;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch (e: any) {
    console.warn('[ray-api] fetch error', e?.message ?? e);
    return null;
  }
  if (!res?.ok) {
    console.warn('[ray-api] fetch by id failed', id, res?.status);
    return null;
  }
  const json = await res.json().catch(() => null);
  const list = (json?.data ?? json) as any[];
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.find((x) => (x?.id ?? x?.pool_id) === id) ?? list[0] ?? null;
}

async function ensureApiPoolInfoForClmm(resolvedId: string): Promise<ApiV3PoolInfoConcentratedItem> {
  let apiItem: any =
    rayIndex.getById(resolvedId) ||
    (await rayIndex.fetchByIdAndCache(resolvedId));

  const looksLikeClmm =
    apiItem &&
    (apiItem.type === 'Concentrated' ||
      apiItem.pooltype === 'Concentrated' ||
      apiItem.category === 'concentrated');

  const hasMints =
    !!(apiItem?.mintA?.address ?? apiItem?.mintA) &&
    !!(apiItem?.mintB?.address ?? apiItem?.mintB);

  const hasProgramAndId =
    !!(apiItem?.programId ?? apiItem?.program_id) &&
    !!(apiItem?.id ?? apiItem?.pool_id);

  if (!looksLikeClmm || !hasMints || !hasProgramAndId) {
    const fetched = await fetchApiPoolById(resolvedId);
    if (!fetched) {
      throw new Error(`raydium: could not fetch API v3 CLMM info for ${resolvedId}`);
    }
    apiItem = fetched;
  }

  const normalized: ApiV3PoolInfoConcentratedItem = {
    id: String(apiItem.id ?? apiItem.pool_id),
    programId: String(apiItem.programId ?? apiItem.program_id),
    type: 'Concentrated',
    mintA:
      typeof apiItem.mintA === 'object'
        ? { address: apiItem.mintA.address }
        : { address: String(apiItem.mintA) },
    mintB:
      typeof apiItem.mintB === 'object'
        ? { address: apiItem.mintB.address }
        : { address: String(apiItem.mintB) },
    config:
      typeof apiItem.config === 'object' && apiItem.config?.id
        ? { id: String(apiItem.config.id) }
        : apiItem.config_id
        ? { id: String(apiItem.config_id) }
        : { id: String(apiItem.config) },
  };

  if (!normalized.id || !normalized.programId || !normalized.mintA?.address || !normalized.mintB?.address) {
    console.error('[ray-api] normalized item missing fields', normalized);
    throw new Error('raydium: normalized API CLMM item missing required fields');
  }

  return normalized;
}

type ClmmTools = { clmm: any; instrument: any };

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

/* -------------------------------- factory -------------------------------- */

export function makeRayClmmEdge(
  connection: Connection,
  poolId: string,
  mintA: string,
  mintB: string,
): PoolEdge & DexEdge {
  const configuredId = new PublicKey(poolId).toBase58();

  async function resolvePoolId(): Promise<string> {
    let p = rayIndex.getById(configuredId);
    if (!p) p = await rayIndex.fetchByIdAndCache(configuredId);

    if (!p) {
      const pairId = rayIndex.findByMints(mintA, mintB);
      let pairPool = pairId ? rayIndex.getById(pairId) : undefined;
      if (!pairPool) {
        pairPool =
          (await rayIndex.fetchByMintsAndCache(mintA, mintB)) ??
          (await rayIndex.fetchByMintsAndCache(mintB, mintA));
      }
      if (!pairPool) {
        console.warn('[ray-edge] miss', { id: configuredId });
        throw new Error(`raydium: api pool not found for ${configuredId}`);
      }
      const resolvedId = (pairPool.id || pairPool.pool_id)?.toString();
      if (!resolvedId) throw new Error(`raydium: api pool missing identifier for ${configuredId}`);
      p = rayIndex.getById(resolvedId)!;
    }

    if (!isTradable(p)) {
      console.warn('[ray-edge] skip locked/untradable pool', {
        id: configuredId,
        status: p.status || p.state,
        liquidity: p.liquidity,
        tvl: p.tvlUsd ?? p.tvl_usd ?? p.tvl,
      });
      throw new Error('raydium: pool locked or no liquidity');
    }

    return (p.id || p.pool_id)!;
  }

  async function buildLiveSwap(
    amountIn: BNType,
    minOut: BNType,
    user: PublicKey,
  ): Promise<{ bundle: SwapInstructionBundle; liveResult: BuildIxResult }> {
    if (IS_SIM) {
      throw new Error('buildSwapIx called in simulate mode; use quote() only.');
    }

    const id = await resolvePoolId();
    const apiItem = await ensureApiPoolInfoForClmm(id);
    const poolInfo: ApiV3PoolInfoConcentratedItem = {
      id: apiItem.id,
      programId: apiItem.programId,
      type: 'Concentrated',
      mintA: { address: apiItem.mintA.address },
      mintB: { address: apiItem.mintB.address },
      config: { id: apiItem.config.id },
    };

    const { clmm, instrument: ClmmInstrument } = await loadClmmTools(connection);
    const poolKeys: ClmmKeys = await clmm.getClmmPoolKeys(id);
    if (!poolKeys?.vault?.A || !poolKeys?.vault?.B) {
      throw new Error(`raydium: failed to load pool vaults on-chain for ${id}`);
    }

    const observationId = new PublicKey(poolKeys.observationId);

    const mintA_pk = mustPk(poolInfo.mintA.address, 'poolInfo.mintA.address');
    const mintB_pk = mustPk(poolInfo.mintB.address, 'poolInfo.mintB.address');

    const inputMintPk = new PublicKey(edge.from);
    const outputMintPk = new PublicKey(edge.to);
    const direction =
      inputMintPk.equals(mintA_pk) && outputMintPk.equals(mintB_pk)
        ? 'AtoB'
        : inputMintPk.equals(mintB_pk) && outputMintPk.equals(mintA_pk)
        ? 'BtoA'
        : null;
    if (!direction) {
      throw new Error(
        `Input/output mint mismatch for Raydium CLMM pool; edge.from=${inputMintPk.toBase58()} edge.to=${outputMintPk.toBase58()}`,
      );
    }

    const tokenAccountA = await ensureAtaPresent(
      connection,
      user,
      mintA_pk,
      'live: raydium mintA ATA',
    );
    const tokenAccountB = await ensureAtaPresent(
      connection,
      user,
      mintB_pk,
      'live: raydium mintB ATA',
    );

    const inputAta = direction === 'AtoB' ? tokenAccountA : tokenAccountB;
    await assertInputBalance(connection, inputAta, amountIn, 'live: raydium source ATA');

    const ownerInfo = { wallet: user, tokenAccountA, tokenAccountB };
    const instrumentInputMint = inputMintPk;
    const sqrtPriceLimitX64 =
      instrumentInputMint.equals(mintA_pk) ? MIN_SQRT_PRICE_X64.add(ONE) : MAX_SQRT_PRICE_X64.sub(ONE);

    if (DEBUG) {
      console.debug('[RAY-CLMM buildSwapIx]', {
        poolId: id,
        observationId: observationId.toBase58(),
        wallet: user.toBase58(),
        mintA: mintA_pk.toBase58(),
        mintB: mintB_pk.toBase58(),
        tokenAccountA: tokenAccountA.toBase58(),
        tokenAccountB: tokenAccountB.toBase58(),
        direction,
        amountIn: amountIn.toString(),
        minOut: minOut.toString(),
        sqrtLimit: sqrtPriceLimitX64.toString(),
      });
    }

    const bundle = ClmmInstrument.makeSwapBaseInInstructions({
      poolInfo,
      poolKeys,
      observationId,
      ownerInfo,
      inputMint: instrumentInputMint,
      amountIn,
      amountOutMin: minOut,
      sqrtPriceLimitX64,
      remainingAccounts: [],
    });

    const rayIxs: TransactionInstruction[] =
      (bundle?.instructions ?? []) as TransactionInstruction[];
    if (!rayIxs.length) {
      throw new Error('raydium: ClmmInstrument returned no instructions');
    }

    const swapBundle: SwapInstructionBundle = { ixs: rayIxs, lookupTables: [] };
    const liveResult: BuildIxResult = { ixs: rayIxs };
    return { bundle: swapBundle, liveResult };
  }

  const edge: any = {
    id: `ray:${configuredId}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    async quote(amountIn: BNType, _user: PublicKey): Promise<Quote> {
      if (amountIn.lte(new BN(0))) throw new Error('raydium: non-positive amountIn');
      const id = await resolvePoolId();
      const { clmm } = await loadClmmTools(connection);
      const { computePoolInfo, tickData } = await clmm.getPoolInfoFromRpc(id);
      const inputMintPk = new PublicKey(this.from);
      const sqrtLimit = inputMintPk.equals(new PublicKey(computePoolInfo.mintA.address))
        ? MIN_SQRT_PRICE_X64.add(ONE)
        : MAX_SQRT_PRICE_X64.sub(ONE);
      const tickCache = tickData[id];
      if (!tickCache) throw new Error(`raydium: tick cache missing for ${id}`);
      const { expectedAmountOut, feeAmount } = PoolUtils.getOutputAmountAndRemainAccounts(
        computePoolInfo,
        tickCache,
        inputMintPk,
        amountIn,
        sqrtLimit,
        true,
      );
      const slippageBps = DEFAULT_SLIPPAGE_BPS;
      const amountOut = expectedAmountOut as BNType;
      const fee = feeAmount as BNType;
      const minOut = amountOut.muln(10_000 - slippageBps).divn(10_000) as BNType;
      return { amountIn, amountOut, fee, minOut };
    },

    async quoteOut(amountIn: bigint): Promise<bigint> {
      const result = await this.quote(toBN(amountIn), PublicKey.default);
      return BigInt(result.amountOut.toString());
    },

    async buildSwapIx(amountIn: BNType | bigint, minOut: BNType | bigint, user: PublicKey): Promise<any> {
      const amountBn = toBN(amountIn as BNType | bigint);
      const minOutBn = toBN(minOut as BNType | bigint);
      const result = await buildLiveSwap(amountBn, minOutBn, user);
      if (BN.isBN(amountIn) || BN.isBN(minOut)) {
        return result.liveResult;
      }
      return result.bundle;
    },
  };

  return edge as PoolEdge & DexEdge;
}

