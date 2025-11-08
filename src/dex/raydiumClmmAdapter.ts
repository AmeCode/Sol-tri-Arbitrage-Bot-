// src/dex/raydiumClmmAdapter.ts
import { strict as assert } from 'assert';
import {
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import BN from 'bn.js';

import {
  MIN_SQRT_PRICE_X64,
  MAX_SQRT_PRICE_X64,
  ONE,
} from '@raydium-io/raydium-sdk-v2';

import { rayIndex } from '../initRay.js';
import type { PoolEdge, SwapInstructionBundle } from '../graph/types.js';
import { isTradable, normMintA, normMintB } from '../ray/clmmIndex.js';
import { ensureAtaIx } from '../tokenAta.js';

const DEBUG = process.env.RAY_CLMM_DEBUG === '1';

/** Robust PublicKey coercion with clear error messages. */
function mustPk(v: string | PublicKey | undefined, label: string): PublicKey {
  if (!v) throw new Error(`raydium: ${label} missing`);
  try {
    // PublicKey ctor accepts both strings and PublicKey; this normalizes either.
    // @ts-ignore – ctor overload handles both correctly
    return new PublicKey(v);
  } catch {
    throw new Error(`raydium: ${label} invalid: ${String(v)}`);
  }
}

/** GET a Raydium API v3 CLMM pool JSON by id. (Node 18+ global fetch) */
async function fetchApiPoolById(id: string): Promise<any | null> {
  const url = `https://api-v3.raydium.io/pools/info/ids?ids=${encodeURIComponent(id)}`;
  const res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } })
    .catch((e) => {
      console.warn('[ray-api] fetch error', e?.message ?? e);
      return null as any;
    });
  if (!res || !res.ok) {
    console.warn('[ray-api] fetch by id failed', id, res?.status);
    return null;
  }
  const json = await res.json().catch(() => null);
  const list = (json?.data ?? json) as any[];
  if (!Array.isArray(list) || list.length === 0) return null;
  // Prefer exact id, otherwise first item
  return list.find((x) => (x?.id ?? x?.pool_id) === id) ?? list[0] ?? null;
}

/**
 * Ensure we have an API v3 CLMM JSON object with the fields
 * required by the SDK instrument.
 */
async function ensureApiPoolInfoForClmm(resolvedId: string): Promise<any> {
  // Try local cache/index first
  let apiItem: any =
    rayIndex.getById(resolvedId) ||
    (await rayIndex.fetchByIdAndCache(resolvedId));

  // Check if it looks like a proper concentrated pool JSON
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

  // Fetch from API if the cached one is missing pieces
  if (!looksLikeClmm || !hasMints || !hasProgramAndId) {
    if (DEBUG) {
      console.warn('[ray-api] local item incomplete → fetching v3', {
        id: resolvedId,
        looksLikeClmm,
        hasMints,
        hasProgramAndId,
      });
    }
    const fetched = await fetchApiPoolById(resolvedId);
    if (!fetched) {
      throw new Error(
        `raydium: could not fetch API v3 CLMM info for ${resolvedId}`
      );
    }
    apiItem = fetched;
  }

  // Normalize to the exact shape the instrument requires
  const normalized = {
    ...apiItem,
    id: apiItem.id ?? apiItem.pool_id,
    programId: apiItem.programId ?? apiItem.program_id,
    // ensure nested objects exist
    mintA:
      typeof apiItem.mintA === 'object'
        ? apiItem.mintA
        : { address: apiItem.mintA },
    mintB:
      typeof apiItem.mintB === 'object'
        ? apiItem.mintB
        : { address: apiItem.mintB },
    config:
      typeof apiItem.config === 'object'
        ? apiItem.config
        : apiItem?.config
        ? { id: apiItem.config }
        : apiItem?.config_id
        ? { id: apiItem.config_id }
        : undefined,
    type: apiItem.type ?? apiItem.pooltype ?? 'Concentrated',
  };

  if (
    !normalized.id ||
    !normalized.programId ||
    !normalized.mintA?.address ||
    !normalized.mintB?.address
  ) {
    console.error('[ray-api] normalized CLMM item missing fields', normalized);
    throw new Error('raydium: normalized API CLMM item missing required fields');
  }

  return normalized;
}

// Lazy SDK loader bound per connection
type ClmmTools = { clmm: any; instrument: any };
const sdkModulePromise = import('@raydium-io/raydium-sdk-v2');
const clmmClientCache = new WeakMap<Connection, Promise<ClmmTools>>();
async function loadClmmTools(connection: Connection): Promise<ClmmTools> {
  let cached = clmmClientCache.get(connection);
  if (!cached) {
    cached = (async () => {
      const { Raydium, Clmm, Api, ClmmInstrument } = await sdkModulePromise;
      const api = new Api({ cluster: 'mainnet' });
      const scope = new Raydium({ connection, api });
      const clmm = new Clmm({ scope, moduleName: 'Clmm' });
      return { clmm, instrument: ClmmInstrument };
    })();
    clmmClientCache.set(connection, cached);
  }
  return cached;
}

// ───────────────────────────────────────────────────────────────────────────────
// Factory
// ───────────────────────────────────────────────────────────────────────────────

export function makeRayClmmEdge(
  connection: Connection,
  poolId: string,
  mintA: string,
  mintB: string,
): PoolEdge {
  const configuredId = new PublicKey(poolId).toBase58();

  async function resolvePoolId(): Promise<string> {
    // fast path: exact id
    let p = rayIndex.getById(configuredId);
    if (!p) p = await rayIndex.fetchByIdAndCache(configuredId);

    if (!p) {
      // try by token pair
      const pairId = rayIndex.findByMints(mintA, mintB);
      let pairPool = pairId ? rayIndex.getById(pairId) : undefined;
      if (!pairPool) {
        pairPool =
          (await rayIndex.fetchByMintsAndCache(mintA, mintB)) ??
          (await rayIndex.fetchByMintsAndCache(mintB, mintA));
      }
      if (!pairPool) {
        console.warn('[ray-edge] miss', {
          id: configuredId,
          debug: `[ray-index] miss for ${configuredId}`,
          note: 'ensure pool id exists in Ray CLMM API',
        });
        throw new Error(`raydium: api pool not found for ${configuredId}`);
      }
      const resolvedId = (pairPool.id || pairPool.pool_id)?.toString();
      if (!resolvedId)
        throw new Error(
          `raydium: api pool missing identifier for ${configuredId}`
        );
      if (resolvedId !== configuredId && DEBUG) {
        console.warn(
          '[ray-edge] replacing configured pool id with API pair result',
          { configured: configuredId, resolved: resolvedId }
        );
      }
      p = rayIndex.getById(resolvedId)!;
    }

    // basic sanity: pool must be tradable
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
      return amountIn;
    },

    async buildSwapIx(
      this: PoolEdge,
      amountIn: bigint,
      minOut: bigint,
      user: PublicKey,
    ): Promise<SwapInstructionBundle> {
      if (amountIn <= 0n) throw new Error('amountIn must be > 0');
      if (minOut < 0n) throw new Error('minOut must be >= 0');

      const id = await resolvePoolId();

      const apiItem = await ensureApiPoolInfoForClmm(id);

      const { clmm, instrument: ClmmInstrument } = await loadClmmTools(connection);
      const { PoolUtils } = await sdkModulePromise;

      const {
        poolInfo: rpcPoolInfo,
        poolKeys: initialPoolKeys,
        computePoolInfo,
        tickData,
      } = await clmm.getPoolInfoFromRpc(id);

      let poolKeys = initialPoolKeys;
      if (!poolKeys?.lookupTableAccount) {
        const fetched = await clmm.getClmmPoolKeys(id);
        poolKeys = { ...poolKeys, lookupTableAccount: fetched.lookupTableAccount };
      }
      if (!poolKeys?.vault?.A || !poolKeys?.vault?.B) {
        throw new Error(`raydium: failed to load pool vaults on-chain for ${id}`);
      }

      const poolInfo = {
        id: rpcPoolInfo.id,
        programId: rpcPoolInfo.programId,
        mintA: { address: rpcPoolInfo.mintA.address },
        mintB: { address: rpcPoolInfo.mintB.address },
        config: { id: rpcPoolInfo.config.id },
      };

      const mintAPk = new PublicKey(apiItem.mintA.address);
      const mintBPk = new PublicKey(apiItem.mintB.address);
      const inputMintPk = new PublicKey(this.from);
      const outputMintPk = new PublicKey(this.to);

      const direction =
        inputMintPk.equals(mintAPk) && outputMintPk.equals(mintBPk)
          ? 'AtoB'
          : inputMintPk.equals(mintBPk) && outputMintPk.equals(mintAPk)
          ? 'BtoA'
          : null;
      if (!direction) {
        throw new Error(
          `Input/output mint mismatch for Raydium CLMM pool; ` +
          `edge.from=${inputMintPk.toBase58()} edge.to=${outputMintPk.toBase58()} ` +
          `pool.mintA=${mintAPk.toBase58()} pool.mintB=${mintBPk.toBase58()}`
        );
      }

      // 5) Ensure ATAs for mints A/B (instrument expects tokenAccountA/B)
      const setupIxs: TransactionInstruction[] = [];
      const ensureA = ensureAtaIx(user, user, mintAPk);
      const ensureB = ensureAtaIx(user, user, mintBPk);
      setupIxs.push(...ensureA.ixs, ...ensureB.ixs);
      const tokenAccountA = ensureA.ata;
      const tokenAccountB = ensureB.ata;

      const ownerInfo = { wallet: user, tokenAccountA, tokenAccountB };

      // 6) Amounts & bounds
      const amountInBn = new BN(amountIn.toString());
      const minOutBn   = new BN(minOut.toString());

      // sqrtPriceLimitX64 must be provided; choose safe bound based on input side
      const sqrtPriceLimitX64 =
        inputMintPk.equals(mintAPk)
          ? MIN_SQRT_PRICE_X64.add(ONE)   // A→B: minimal price bound + ε
          : MAX_SQRT_PRICE_X64.sub(ONE);  // B→A: maximal price bound − ε

      // observationId is required by instrument signature; use the one from poolKeys
      const observationId = mustPk(poolKeys.observationId, 'poolKeys.observationId');

      // inputMint param must be the actual input side
      const instrumentInputMint = inputMintPk;

      const poolTickCache = tickData[id] ?? tickData[computePoolInfo.id.toBase58()];
      if (!poolTickCache) {
        throw new Error(`raydium: missing tick array cache for ${id}`);
      }

      const { remainingAccounts } = PoolUtils.getOutputAmountAndRemainAccounts(
        computePoolInfo,
        poolTickCache,
        instrumentInputMint,
        amountInBn,
        sqrtPriceLimitX64,
      );

      if (DEBUG) {
        console.debug('[RAY-CLMM buildSwapIx]', {
          poolId: id,
          programId: String(poolInfo.programId),
          wallet: user.toBase58(),
          mintA: mintAPk.toBase58(),
          mintB: mintBPk.toBase58(),
          vaultA: String(poolKeys.vault.A),
          vaultB: String(poolKeys.vault.B),
          tokenAccountA: tokenAccountA.toBase58(),
          tokenAccountB: tokenAccountB.toBase58(),
          observationId: observationId.toBase58(),
          direction,
          amountIn: amountIn.toString(),
          minOut: minOut.toString(),
          sqrtLimit: sqrtPriceLimitX64.toString(),
        });
      }

      // 7) Build Raydium CLMM swap instructions (SDK v2)
      const bundle = ClmmInstrument.makeSwapBaseInInstructions({
        poolInfo,
        poolKeys,
        observationId,
        ownerInfo,
        inputMint: instrumentInputMint,
        amountIn: amountInBn,
        amountOutMin: minOutBn,
        sqrtPriceLimitX64,
        remainingAccounts,
      });

      const rayIxs: TransactionInstruction[] = (bundle?.instructions ?? []) as TransactionInstruction[];
      const rayLuts: PublicKey[] = ((bundle?.lookupTableAddress ?? []) as string[])
        .filter((s) => !!s)
        .map((s) => new PublicKey(s));

      if (DEBUG && rayLuts.length) {
        console.debug('[RayCLMM] LUTs from SDK (order matters!)', rayLuts.map((p) => p.toBase58()));
      }

      if (!rayIxs.length) {
        throw new Error('raydium: ClmmInstrument returned no instructions');
      }

      return {
        ixs: [...setupIxs, ...rayIxs],
        lookupTables: rayLuts,
      };
    },
  };
}

