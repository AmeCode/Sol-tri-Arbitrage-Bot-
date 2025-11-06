import { PublicKey, TransactionInstruction, SystemProgram } from '@solana/web3.js';
import type { PoolEdge, SwapInstructionBundle } from '../graph/types.js';
import { NATIVE_MINT } from '@solana/spl-token';
import { ensureAtaIx, wrapSolIntoAta } from '../tokenAta.js';

/**
 * METEORA DLMM (lightweight) adapter with:
 * - Strong input validation (PublicKey strings, amounts)
 * - Clear, labeled errors
 * - Optional debug logging
 * - Safer u64 encoding helpers
 *
 * NOTE: This is a minimal placeholder encoder. For production you should
 *       swap in the official DLMM SDK and resolve the real account metas.
 */

// ───────────────────────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────────────────────

/** Toggle verbose logs at runtime with env or change to `true` to always log. */
const DEBUG = process.env.DLMM_DEBUG === '1';

/** Placeholder DLMM program id — replace with the real one in your env/config. */
const DLMM_PROGRAM_ID = toPk(
  process.env.DLMM_PROGRAM_ID ?? 'DLMM1qU5xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'DLMM program id'
);

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function log(...args: any[]) {
  if (DEBUG) console.debug('[DLMM]', ...args);
}

function toPk(value: string, label: string): PublicKey {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is empty or not a string: ${String(value)}`);
  }
  const s = value.trim();
  try {
    return new PublicKey(s);
  } catch {
    throw new Error(`${label} is not a valid Solana public key: '${s}'`);
  }
}

function assert(condition: any, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

/** Write a u64 LE into a Buffer at offset, validating safe range. */
function writeU64LE(buf: Buffer, value: bigint, offset: number, label: string) {
  assert(value >= 0n, `${label} must be >= 0`);
  // u64 max
  const U64_MAX = (1n << 64n) - 1n;
  assert(value <= U64_MAX, `${label} exceeds u64 max (${U64_MAX.toString()})`);
  buf.writeBigUInt64LE(value, offset);
}

/** Pretty-print a key list for debugging TransactionInstruction keys. */
function describeKeys(keys: ReadonlyArray<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>) {
  return keys.map(k => ({
    pubkey: k.pubkey.toBase58(),
    isSigner: k.isSigner,
    isWritable: k.isWritable,
  }));
}

/**
 * Minimal DLMM swap encoder.
 * This ONLY encodes a fake "swap" tag + amountIn + minOut. Real DLMM requires
 * many more accounts and exact data layout which the official SDK provides.
 */
function encodeDlmmSwap(params: {
  programId: PublicKey;
  poolId: PublicKey;
  user: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  amountIn: bigint;
  minOut: bigint;
  sourceTokenAccount: PublicKey;
  destinationTokenAccount: PublicKey;
}): TransactionInstruction {
  // Sanity checks
  assert(!params.inputMint.equals(params.outputMint), 'inputMint and outputMint must differ');
  assert(params.amountIn > 0n, 'amountIn must be > 0');
  assert(params.minOut >= 0n, 'minOut must be >= 0');

  // Data layout (placeholder):
  // [u8 method_tag=1][u64 amountIn][u64 minOut]
  const data = Buffer.alloc(1 + 8 + 8);
  data.writeUInt8(1, 0); // "swap" tag (placeholder)
  writeU64LE(data, params.amountIn, 1, 'amountIn');
  writeU64LE(data, params.minOut, 9, 'minOut');

  // NOTE: A real DLMM swap needs token vaults, ATA accounts, token program, etc.
  // We include just a minimal set here for visibility.
  const keys = [
    { pubkey: params.user,   isSigner: true,  isWritable: true  }, // payer
    { pubkey: params.poolId, isSigner: false, isWritable: true  }, // pool state
    { pubkey: params.sourceTokenAccount, isSigner: false, isWritable: true },
    { pubkey: params.destinationTokenAccount, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];

  log('encodeDlmmSwap()', {
    programId: params.programId.toBase58(),
    poolId: params.poolId.toBase58(),
    user: params.user.toBase58(),
    inputMint: params.inputMint.toBase58(),
    outputMint: params.outputMint.toBase58(),
    amountIn: params.amountIn.toString(),
    minOut: params.minOut.toString(),
    keys: describeKeys(keys),
    dataHex: data.toString('hex'),
  });

  return new TransactionInstruction({
    programId: params.programId,
    keys,
    data,
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────────────

export function makeMeteoraEdge(poolId: string, inputMint: string, outputMint: string): PoolEdge {
  const poolPk   = toPk(poolId, 'DLMM pool id');
  const inMintPk = toPk(inputMint, 'inputMint');
  const outMintPk= toPk(outputMint, 'outputMint');

  return {
    id: `meteora:${poolPk.toBase58()}`,
    from: inMintPk.toBase58(),
    to: outMintPk.toBase58(),
    feeBps: 0,

    /**
     * Super-conservative placeholder quote: returns 1:1.
     * Replace with real DLMM on-chain read or official SDK compute when ready.
     */
    async quoteOut(amountIn: bigint): Promise<bigint> {
      log('quoteOut()', {
        pool: poolPk.toBase58(),
        from: inMintPk.toBase58(),
        to: outMintPk.toBase58(),
        amountIn: amountIn.toString(),
      });
      return amountIn;
    },

    /**
     * Build swap ixs with clear validation + debug output.
     * Replace with the official SDK’s builder to get the full account metas.
     */
    async buildSwapIx(
      amountIn: bigint,
      minOut: bigint,
      user: PublicKey,
    ): Promise<SwapInstructionBundle> {
      assert(user instanceof PublicKey, 'user must be a PublicKey');
      log('buildSwapIx()', {
        user: user.toBase58(),
        pool: poolPk.toBase58(),
        from: inMintPk.toBase58(),
        to: outMintPk.toBase58(),
        amountIn: amountIn.toString(),
        minOut: minOut.toString(),
        programId: DLMM_PROGRAM_ID.toBase58(),
      });

      const setupIxs: TransactionInstruction[] = [];

      let sourceAta: PublicKey;
      if (inMintPk.equals(NATIVE_MINT)) {
        const wrapped = wrapSolIntoAta(user, user, amountIn);
        setupIxs.push(...wrapped.ixs);
        sourceAta = wrapped.ata;
      } else {
        const ensured = ensureAtaIx(user, user, inMintPk);
        setupIxs.push(...ensured.ixs);
        sourceAta = ensured.ata;
      }

      const ensuredDst = ensureAtaIx(user, user, outMintPk);
      setupIxs.push(...ensuredDst.ixs);
      const destinationAta = ensuredDst.ata;

      const ix = encodeDlmmSwap({
        programId: DLMM_PROGRAM_ID,
        poolId: poolPk,
        user,
        inputMint: inMintPk,
        outputMint: outMintPk,
        amountIn,
        minOut,
        sourceTokenAccount: sourceAta,
        destinationTokenAccount: destinationAta,
      });

      return { ixs: [...setupIxs, ix] };
    },
  };
}

