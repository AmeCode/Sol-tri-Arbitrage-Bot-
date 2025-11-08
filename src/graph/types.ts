import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';

/**
 * A mint address on Solana. Mints are represented by their string public key.
 */
export type Mint = string;

export interface SwapInstructionBundle {
  ixs: TransactionInstruction[];
  extraSigners?: Keypair[];
  lookupTableAddresses?: (PublicKey | string)[];
}

export interface PoolEdge {
  /** Unique identifier for this edge (e.g. dex:poolId) */
  id: string;
  /** Token being swapped from. */
  from: Mint;
  /** Token being swapped to. */
  to: Mint;
  /** Total swap fee in basis points. */
  feeBps: number;
  /**
   * Calculate the output amount for a given input amount.
   * Returns zero on failure rather than throwing so callers can skip bad edges.
   */
  quoteOut(amountIn: bigint): Promise<bigint>;
  /**
   * Build one or more transaction instructions to perform this swap.  The
   * returned instructions must not be signed; the caller is responsible for
   * paying fees and signing.
   *
   * @param amountIn input amount
   * @param minOut minimum acceptable output amount
   * @param user payer public key
   */
  buildSwapIx(
    amountIn: bigint,
    minOut: bigint,
    user: PublicKey,
  ): Promise<SwapInstructionBundle>;
}

