// src/dex/jupiterAdapter.ts
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { PoolEdge } from '../graph/types.js';
import { CFG } from '../config.js';
import { createJupiterApiClient, type Instruction, type AccountMeta as JupAccountMeta } from '@jup-ag/api';

/** Initialize once (either Metis/QuickNode endpoint or the public endpoint) */
const JUP_BASE = process.env.METIS_ENDPOINT ?? 'https://public.jupiterapi.com';
const jupiter = createJupiterApiClient({ basePath: JUP_BASE });

/** Convert Jupiter Instruction → web3 TransactionInstruction */
function toIx(ins: Instruction | undefined): TransactionInstruction | null {
  if (!ins) return null;
  return new TransactionInstruction({
    programId: new PublicKey(ins.programId),
    keys: (ins.accounts as JupAccountMeta[]).map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ins.data, 'base64'),
  });
}

export function jupEdge(fromMint: string, toMint: string): PoolEdge {
  const id = `jup:${fromMint}->${toMint}`;

  return {
    id,
    from: fromMint,
    to: toMint,
    feeBps: 0,

    /** Ask Jupiter for the best route and return expected outAmount (in base units) */
    async quoteOut(amountIn: bigint): Promise<bigint> {
      // Jupiter wants integer base units (no decimals)
      const q = await jupiter.quoteGet({
        inputMint: fromMint,
        outputMint: toMint,
        amount: Number(amountIn), // amountIn already in base units
        slippageBps: CFG.maxSlippageBps,
        platformFeeBps: CFG.jupiterPlatformFeeBps,
      });
      if (!q || !q.outAmount) return 0n;
      return BigInt(q.outAmount);
    },

    /** Build swap instructions for this leg using Jupiter swap-instructions */
    async buildSwapIx(amountIn: bigint, _minOut: bigint, user: PublicKey): Promise<TransactionInstruction[]> {
      // Get a fresh quote (so the instructions correspond exactly to this amount)
      const quote = await jupiter.quoteGet({
        inputMint: fromMint,
        outputMint: toMint,
        amount: Number(amountIn),
        slippageBps: CFG.maxSlippageBps,
        platformFeeBps: CFG.jupiterPlatformFeeBps,
      });
      if (!quote) throw new Error('jupiter: no route');

      const { computeBudgetInstructions, setupInstructions, swapInstruction, cleanupInstruction } =
        await jupiter.swapInstructionsPost({
          swapRequest: {
            quoteResponse: quote,
            userPublicKey: user.toBase58(),
            // Let Jupiter set a reasonable CU price; we also add our own CU ix in index.ts
            asLegacyTransaction: false,
            // These defaults match what we used before
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
          },
        });

      const ixs: (TransactionInstruction | null)[] = [
        ...computeBudgetInstructions.map(toIx),
        ...setupInstructions.map(toIx),
        toIx(swapInstruction),
        toIx(cleanupInstruction),
      ];

      return ixs.filter(Boolean) as TransactionInstruction[];
    },
  };
}

export function getEdgesFromJupiter(mints: string[]): PoolEdge[] {
  const edges: PoolEdge[] = [];
  for (const a of mints) for (const b of mints) {
    if (a === b) continue;
    edges.push(jupEdge(a, b));
  }
  return edges;
}

