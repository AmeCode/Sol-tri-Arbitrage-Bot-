import { AddressLookupTableAccount, PublicKey, TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';

type BNType = InstanceType<typeof BN>;

export type Quote = {
  amountIn: BNType;
  amountOut: BNType;
  fee: BNType;
  minOut: BNType;
};

export type BuildIxResult = {
  ixs: TransactionInstruction[];
  lookupTables?: AddressLookupTableAccount[];
};

export interface DexEdge {
  from: string;
  to: string;
  quote(amountIn: BNType, user: PublicKey): Promise<Quote>;
  buildSwapIx(amountIn: BNType, minOut: BNType, user: PublicKey): Promise<BuildIxResult>;
}
