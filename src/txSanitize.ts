import { PublicKey, TransactionInstruction } from '@solana/web3.js';

/**
 * Force *only* payer to be a signer in every ix meta.
 * This removes accidental extra signers which cause "Transaction signature verification failure".
 */
export function sanitizeOnlyWalletSigns(
  instructions: TransactionInstruction[],
  payer: PublicKey
): TransactionInstruction[] {
  return instructions.map(ix => {
    const keys = ix.keys.map(k => {
      // keep original writability, drop signer unless this is the payer
      const isSigner = k.pubkey.equals(payer);
      return { pubkey: k.pubkey, isWritable: k.isWritable, isSigner };
    });
    return new TransactionInstruction({
      programId: ix.programId,
      keys,
      data: ix.data,
    });
  });
}
