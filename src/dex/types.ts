import { PublicKey } from '@solana/web3.js';
import type { SwapInstructionBundle } from '../graph/types.js';

export interface DexAdapterEdge {
  id: string;
  from: string;
  to: string;
  feeBps: number;
  quoteOut(amountIn: bigint): Promise<bigint>;
  buildSwapIx(
    amountIn: bigint,
    minOut: bigint,
    user: PublicKey,
  ): Promise<SwapInstructionBundle>;
}
