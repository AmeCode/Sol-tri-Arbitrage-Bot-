// src/dex/meteoraDlmmAdapter.ts
import {
  PublicKey,
  TransactionInstruction,
  Connection,
} from '@solana/web3.js';
import BN from 'bn.js';
import { NATIVE_MINT, AccountLayout } from '@solana/spl-token';
import { createRequire } from 'module';

import type { PoolEdge, SwapInstructionBundle } from '../graph/types.js';
import { ensureAtaIx, wrapSolIntoAta } from '../tokenAta.js';
import { RUNTIME } from '../runtime.js';
import { mustAccount } from '../onchain/assertions.js';

// ───────────────────────────────────────────────────────────────────────────────
// Config / utils
// ───────────────────────────────────────────────────────────────────────────────

const DEBUG = process.env.DLMM_DEBUG === '1';

function log(...args: any[]) {
  if (DEBUG) console.debug('[DLMM]', ...args);
}

function toPk(value: string, label: string): PublicKey {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is empty or not a string: ${String(value)}`);
  }
  try {
    return new PublicKey(value.trim());
  } catch {
    throw new Error(`${label} is not a valid public key: '${value}'`);
  }
}

function normalizeLookupTables(input: unknown): PublicKey[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  const out: PublicKey[] = [];
  for (const value of arr) {
    if (!value) continue;
    try {
      out.push(value instanceof PublicKey ? value : new PublicKey(value));
    } catch {
      /* ignore invalid entries */
    }
  }
  return out;
}

function assert(condition: any, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

// ───────────────────────────────────────────────────────────────────────────────
// DLMM pool cache (avoid creating per call)
// ───────────────────────────────────────────────────────────────────────────────

type DLMMType = any; // (SDK types differ across versions; keep runtime-flexible)
const require = createRequire(import.meta.url);

const dlmmCache = new Map<string, DLMMType>();

let cachedSdk: any | null = null;

function loadSdk(): any {
  if (cachedSdk) return cachedSdk;

  const candidates = [
    '@meteora-ag/dlmm/dist/cjs/index.js',
    '@meteora-ag/dlmm/dist/cjs',
    '@meteora-ag/dlmm',
  ];

  for (const id of candidates) {
    try {
      const mod = require(id);
      cachedSdk = mod?.default ?? mod;
      return cachedSdk;
    } catch (err) {
      if (DEBUG) log('failed to load DLMM SDK candidate', id, err);
    }
  }

  throw new Error(
    `Unable to load Meteora DLMM SDK. Tried candidates: ${candidates.join(', ')}`,
  );
}

async function loadDlmm(connection: Connection, poolPk: PublicKey): Promise<DLMMType> {
  const k = poolPk.toBase58();
  const cached = dlmmCache.get(k);
  if (cached) return cached;
  // Most versions expose: `const pool = await DLMM.create(connection, poolPk)`
  const sdk = loadSdk();
  const pool = await sdk.create(connection, poolPk);
  dlmmCache.set(k, pool);
  return pool;
}

/** Map input/output mints to the SDK's boolean direction (`isXtoY`). */
function resolveDirectionBool(dlmm: DLMMType, inMint: PublicKey, outMint: PublicKey): boolean | null {
  // Most SDK builds expose either `tokenX/tokenY.publicKey` OR `state.mintX/mintY`
  const tokenX: PublicKey | undefined =
    dlmm?.tokenX?.publicKey ?? dlmm?.state?.mintX ?? dlmm?.state?.mintA;
  const tokenY: PublicKey | undefined =
    dlmm?.tokenY?.publicKey ?? dlmm?.state?.mintY ?? dlmm?.state?.mintB;

  if (!tokenX || !tokenY) return null;

  if (inMint.equals(tokenX) && outMint.equals(tokenY)) return true;  // X -> Y
  if (inMint.equals(tokenY) && outMint.equals(tokenX)) return false; // Y -> X
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Factory (requires a Connection)
// ───────────────────────────────────────────────────────────────────────────────

export function makeMeteoraEdge(
  connection: Connection,
  poolId: string,
  inputMint: string,
  outputMint: string,
): PoolEdge {
  const poolPk    = toPk(poolId, 'DLMM pool id');
  const inMintPk  = toPk(inputMint, 'input mint');
  const outMintPk = toPk(outputMint, 'output mint');

  return {
    id: `meteora:${poolPk.toBase58()}`,
    from: inMintPk.toBase58(),
    to: outMintPk.toBase58(),
    feeBps: 0,

    // --- Quote ---
    async quoteOut(amountIn: bigint): Promise<bigint> {
      if (amountIn <= 0n) return 0n;

      const dlmm = await loadDlmm(connection, poolPk);
      const dir = resolveDirectionBool(dlmm, inMintPk, outMintPk);
      if (dir === null) {
        if (DEBUG) log('quoteOut: mint mismatch', {
          pool: poolPk.toBase58(),
          in: inMintPk.toBase58(),
          out: outMintPk.toBase58(),
        });
        return 0n;
      }

      const bnIn = new BN(amountIn.toString());

      // Prefer newer API if available
      if (typeof dlmm.swapQuoteByInputToken === 'function') {
        // Newer SDKs: `swapQuoteByInputToken(amountInBN, isXtoY)`
        const q = await dlmm.swapQuoteByInputToken(bnIn, dir);
        const out = BigInt(q.amountOut.toString());
        if (DEBUG) log('quoteOut:newAPI', { isXtoY: dir, amountIn: amountIn.toString(), amountOut: out.toString() });
        return out > 0n ? out : 0n;
      }

      // Fallback: bin-array route + exact-in quote
      const BinAPI = loadSdk();
      if (typeof BinAPI.getBinArrayForSwap !== 'function') {
        if (DEBUG) log('quoteOut: no supported quote method on this SDK build');
        return 0n;
      }
      const binArrays = await BinAPI.getBinArrayForSwap(connection, poolPk, dir);
      if (typeof dlmm.swapQuoteExactIn !== 'function') {
        if (DEBUG) log('quoteOut: missing swapQuoteExactIn on SDK build');
        return 0n;
      }

      // Signature seen in examples: swapQuoteExactIn(amountIn, isXtoY, treeLevel, binArrays, slippage)
      const q = await dlmm.swapQuoteExactIn(bnIn, dir, 1, binArrays, 0);
      const out = BigInt(q.amountOut.toString());
      if (DEBUG) log('quoteOut:legacyAPI', { isXtoY: dir, amountIn: amountIn.toString(), amountOut: out.toString() });
      return out > 0n ? out : 0n;
    },

    // --- Build swap instruction(s) ---
    async buildSwapIx(
      amountIn: bigint,
      minOut: bigint,
      user: PublicKey,
    ): Promise<SwapInstructionBundle> {
      assert(amountIn > 0n, 'amountIn must be > 0');
      assert(minOut >= 0n, 'minOut must be >= 0');

      const dlmm = await loadDlmm(connection, poolPk);
      const dir = resolveDirectionBool(dlmm, inMintPk, outMintPk);
      if (dir === null) {
        throw new Error('DLMM pool does not match input/output mints');
      }

      // Prep ATAs & wrap WSOL (input)
      const setupIxs: TransactionInstruction[] = [];

      const ensuredSrc = ensureAtaIx(user, user, inMintPk);
      let sourceAta: PublicKey = ensuredSrc.ata;

      if (inMintPk.equals(NATIVE_MINT)) {
        if (RUNTIME.mode === 'simulate') {
          if (RUNTIME.requirePrealloc) {
            const info = await mustAccount(connection, sourceAta, 'simulate: meteora WSOL ATA');
            const available = BigInt(AccountLayout.decode(info.data).amount.toString());
            if (available < amountIn) {
              throw new Error(
                `simulate: meteora WSOL ATA ${sourceAta.toBase58()} has ${available}, needs ${amountIn}`,
              );
            }
          }
        } else {
          if (!RUNTIME.wsolPrewrap) {
            const wrapped = wrapSolIntoAta(user, user, amountIn);
            setupIxs.push(...wrapped.ixs);
            sourceAta = wrapped.ata;
          } else if (ensuredSrc.ixs.length) {
            setupIxs.push(...ensuredSrc.ixs);
          }
        }
      } else {
        if (RUNTIME.mode === 'live') {
          if (ensuredSrc.ixs.length) setupIxs.push(...ensuredSrc.ixs);
        } else if (RUNTIME.requirePrealloc) {
          const info = await mustAccount(connection, sourceAta, 'simulate: meteora source ATA');
          const available = BigInt(AccountLayout.decode(info.data).amount.toString());
          if (available < amountIn) {
            throw new Error(
              `simulate: meteora source ATA ${sourceAta.toBase58()} has ${available}, needs ${amountIn}`,
            );
          }
        }
      }

      const ensuredDst = ensureAtaIx(user, user, outMintPk);
      if (RUNTIME.mode === 'live') {
        if (ensuredDst.ixs.length) setupIxs.push(...ensuredDst.ixs);
      } else if (RUNTIME.requirePrealloc) {
        await mustAccount(connection, ensuredDst.ata, 'simulate: meteora destination ATA');
      }
      const destinationAta = ensuredDst.ata;

      const bnIn = new BN(amountIn.toString());
      const bnMin = new BN(minOut.toString());

      // Try newer swap API first (minAmountOut supported)
      if (typeof dlmm.swap === 'function') {
        // Many builds accept: { owner, isXtoY, amountIn, minAmountOut, tokenAccountIn, tokenAccountOut }
        // Some also require: tokenIn, tokenOut (mints). Pass when available; harmless otherwise.
        const args: any = {
          owner: user,
          isXtoY: dir,
          amountIn: bnIn,
          minAmountOut: bnMin,
          tokenAccountIn: sourceAta,
          tokenAccountOut: destinationAta,
          tokenIn: inMintPk,
          tokenOut: outMintPk,
        };

        // Some older builds require bin arrays in swap call; supply if needed.
        const sdk = loadSdk();
        if (typeof sdk.getBinArrayForSwap === 'function') {
          try {
            const binArrays = await sdk.getBinArrayForSwap(connection, poolPk, dir);
            args.binArrays = binArrays;
          } catch {
            // ignore; not all versions need this
          }
        }

        const { innerTransaction } = await dlmm.swap(args);
        const ixs = (innerTransaction?.instructions ?? []) as TransactionInstruction[];
        const lookupTables = normalizeLookupTables(
          (innerTransaction as any)?.lookupTableAddress ??
            (innerTransaction as any)?.lookupTableAddresses,
        );

        if (DEBUG) {
          log('buildSwapIx:newAPI', {
            isXtoY: dir,
            ixs: ixs.length,
            src: sourceAta.toBase58(),
            dst: destinationAta.toBase58(),
            amountIn: amountIn.toString(),
            minOut: minOut.toString(),
          });
        }

        return { ixs: [...setupIxs, ...ixs], lookupTables };
      }

      // Fallback path: legacy quote + swap
      const BinAPI = loadSdk();
      assert(typeof BinAPI.getBinArrayForSwap === 'function', 'DLMM SDK missing getBinArrayForSwap');

      const binArrays = await BinAPI.getBinArrayForSwap(connection, poolPk, dir);

      // Older builds: swap(...) may use { owner, isXtoY, amount, slippage, tokenAccountIn, tokenAccountOut, binArrays }
      // Enforce minOut by recomputing quote here (defensive)
      if (typeof dlmm.swapQuoteExactIn === 'function') {
        const q = await dlmm.swapQuoteExactIn(bnIn, dir, 1, binArrays, 0);
        const expectedOut = BigInt(q.amountOut.toString());
        if (expectedOut < minOut) {
          throw new Error(`DLMM quote below minOut: got ${expectedOut}, need >= ${minOut}`);
        }
      }

      const { innerTransaction } = await dlmm.swap({
        owner: user,
        isXtoY: dir,
        amount: bnIn,
        slippage: 0,
        tokenAccountIn: sourceAta,
        tokenAccountOut: destinationAta,
        binArrays,
        tokenIn: inMintPk,
        tokenOut: outMintPk,
      });

      const ixs = (innerTransaction?.instructions ?? []) as TransactionInstruction[];
      const lookupTables = normalizeLookupTables(
        (innerTransaction as any)?.lookupTableAddress ??
          (innerTransaction as any)?.lookupTableAddresses,
      );

      if (DEBUG) {
        log('buildSwapIx:legacyAPI', {
          isXtoY: dir,
          ixs: ixs.length,
          src: sourceAta.toBase58(),
          dst: destinationAta.toBase58(),
          amountIn: amountIn.toString(),
          minOut: minOut.toString(),
        });
      }

      return { ixs: [...setupIxs, ...ixs], lookupTables };
    },
  };
}

