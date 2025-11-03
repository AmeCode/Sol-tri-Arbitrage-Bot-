import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export interface DexAdapterEdge {
  id: string;
  from: string;
  to: string;
  feeBps: number;
  quoteOut(amountIn: bigint): Promise<bigint>;
  buildSwapIx(amountIn: bigint, minOut: bigint, user: PublicKey): Promise<TransactionInstruction[]>;
}
