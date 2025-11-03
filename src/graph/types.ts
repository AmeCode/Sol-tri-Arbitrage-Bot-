import { PublicKey, TransactionInstruction } from '@solana/web3.js';


export interface PoolEdge {
  id: string;
  from: Mint;
  to: Mint;
  feeBps: number;
  quoteOut(amountIn: bigint): Promise<bigint>;
  buildSwapIx(amountIn: bigint, minOut: bigint, user: PublicKey): Promise<TransactionInstruction[]>;
}

