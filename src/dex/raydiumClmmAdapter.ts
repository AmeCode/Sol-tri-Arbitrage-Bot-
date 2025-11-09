// src/dex/raydiumClmmAdapter.ts
import { strict as assert } from 'assert';
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
import { RUNTIME } from '../runtime.js';
import { mustAccount } from '../onchain/assertions.js';
import { AccountLayout } from '@solana/spl-token';

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

const DEBUG = process.env.RAY_CLMM_DEBUG === '1';

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
): PoolEdge {
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

  return {
    id: `ray:${configuredId}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    async quoteOut(amountIn: bigint): Promise<bigint> {
      if (amountIn <= 0n) throw new Error('raydium: non-positive amountIn');
      // Plug a real quote here if you wish; pass-through keeps router logic alive.
      return amountIn;
    },

    async buildSwapIx(
      amountIn: bigint,
      minOut: bigint,
      user: PublicKey,
    ): Promise<SwapInstructionBundle> {
      assert(amountIn > 0n, 'amountIn must be > 0');
      assert(minOut >= 0n, 'minOut must be >= 0');

      const id = await resolvePoolId();

      // 1) API JSON → poolInfo (minimal Pick<>)
      const apiItem = await ensureApiPoolInfoForClmm(id);
      const poolInfo: ApiV3PoolInfoConcentratedItem = {
        id: apiItem.id,
        programId: apiItem.programId,
        type: 'Concentrated',
        mintA: { address: apiItem.mintA.address },
        mintB: { address: apiItem.mintB.address },
        config: { id: apiItem.config.id },
      };

      // 2) On-chain keys → poolKeys (vaults/obs/lookupTable)
      const { clmm, instrument: ClmmInstrument } = await loadClmmTools(connection);
      const poolKeys: ClmmKeys = await clmm.getClmmPoolKeys(id);
      if (!poolKeys?.vault?.A || !poolKeys?.vault?.B) {
        throw new Error(`raydium: failed to load pool vaults on-chain for ${id}`);
      }

      const observationId = new PublicKey(poolKeys.observationId);

      // Validate keys we need
      const mintA_pk = mustPk(poolInfo.mintA.address, 'poolInfo.mintA.address');
      const mintB_pk = mustPk(poolInfo.mintB.address, 'poolInfo.mintB.address');
      const vaultA_pk = mustPk(poolKeys.vault?.A, 'poolKeys.vault.A');
      const vaultB_pk = mustPk(poolKeys.vault?.B, 'poolKeys.vault.B');

      // 3) Direction & input mint (based on edge.from/edge.to)
      const inputMintPk = new PublicKey(this.from);
      const outputMintPk = new PublicKey(this.to);
      const direction =
        inputMintPk.equals(mintA_pk) && outputMintPk.equals(mintB_pk)
          ? 'AtoB'
          : inputMintPk.equals(mintB_pk) && outputMintPk.equals(mintA_pk)
          ? 'BtoA'
          : null;
      if (!direction) {
        throw new Error(
          `Input/output mint mismatch for Raydium CLMM pool; ` +
          `edge.from=${inputMintPk.toBase58()} edge.to=${outputMintPk.toBase58()} ` +
          `pool.mintA=${mintA_pk.toBase58()} pool.mintB=${mintB_pk.toBase58()}`
        );
      }

      // 4) Ensure ATAs for both pool mints; map to tokenAccountA/B
      const setupIxs: TransactionInstruction[] = [];
      const ensuredA = ensureAtaIx(user, user, mintA_pk);
      const ensuredB = ensureAtaIx(user, user, mintB_pk);
      let mintAInfo: Awaited<ReturnType<typeof mustAccount>> | null = null;
      let mintBInfo: Awaited<ReturnType<typeof mustAccount>> | null = null;

      if (RUNTIME.mode === 'live') {
        if (ensuredA.ixs.length) setupIxs.push(...ensuredA.ixs);
        if (ensuredB.ixs.length) setupIxs.push(...ensuredB.ixs);
      } else if (RUNTIME.requirePrealloc) {
        mintAInfo = await mustAccount(connection, ensuredA.ata, 'simulate: raydium mintA ATA');
        mintBInfo = await mustAccount(connection, ensuredB.ata, 'simulate: raydium mintB ATA');
      }

      const tokenAccountA = ensuredA.ata;
      const tokenAccountB = ensuredB.ata;

      if (RUNTIME.mode === 'simulate' && RUNTIME.requirePrealloc) {
        const inputAta = direction === 'AtoB' ? tokenAccountA : tokenAccountB;
        const outputAta = direction === 'AtoB' ? tokenAccountB : tokenAccountA;
        const inputInfo =
          direction === 'AtoB'
            ? mintAInfo ?? (await mustAccount(connection, inputAta, 'simulate: raydium input ATA'))
            : mintBInfo ?? (await mustAccount(connection, inputAta, 'simulate: raydium input ATA'));
        const decoded = AccountLayout.decode(inputInfo.data);
        const available = BigInt(decoded.amount.toString());
        if (available < amountIn) {
          throw new Error(
            `simulate: raydium input ATA ${inputAta.toBase58()} has ${available}, needs ${amountIn}`,
          );
        }
        await mustAccount(connection, outputAta, 'simulate: raydium output ATA');
      }

      const ownerInfo = { wallet: user, tokenAccountA, tokenAccountB };

      // 5) Amounts & price limits
      const instrumentInputMint = inputMintPk; // the actual input side
      const amountInBn = new BN(amountIn.toString());
      const minOutBn = new BN(minOut.toString());
      const sqrtPriceLimitX64 =
        instrumentInputMint.equals(mintA_pk)
          ? MIN_SQRT_PRICE_X64.add(ONE)
          : MAX_SQRT_PRICE_X64.sub(ONE);

      if (DEBUG) {
        console.debug('[RAY-CLMM buildSwapIx]', {
          poolId: id,
          observationId: observationId.toBase58(),
          wallet: user.toBase58(),
          mintA: mintA_pk.toBase58(),
          mintB: mintB_pk.toBase58(),
          vaultA: vaultA_pk.toBase58(),
          vaultB: vaultB_pk.toBase58(),
          tokenAccountA: tokenAccountA.toBase58(),
          tokenAccountB: tokenAccountB.toBase58(),
          direction,
          inputMint: instrumentInputMint.toBase58(),
          amountIn: amountIn.toString(),
          minOut: minOut.toString(),
          sqrtLimit: sqrtPriceLimitX64.toString(),
          lut: poolKeys.lookupTableAccount ?? null,
        });
      }

      // 7) Build swap instructions (remainingAccounts optional)
      const bundle = ClmmInstrument.makeSwapBaseInInstructions({
        poolInfo,
        poolKeys,
        observationId,
        ownerInfo,
        inputMint: instrumentInputMint,
        amountIn: amountInBn,
        amountOutMin: minOutBn,
        sqrtPriceLimitX64,
        remainingAccounts: [],
      });

      const rayIxs: TransactionInstruction[] =
        (bundle?.instructions ?? []) as TransactionInstruction[];
      if (!rayIxs.length) {
        throw new Error('raydium: ClmmInstrument returned no instructions');
      }

      const lookupTables = poolKeys.lookupTableAccount
        ? [new PublicKey(poolKeys.lookupTableAccount)]
        : [];

      return { ixs: [...setupIxs, ...rayIxs], lookupTables };
    },
  };
}

