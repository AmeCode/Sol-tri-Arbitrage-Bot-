import { PublicKey, TransactionInstruction } from '@solana/web3.js';

export function sanitizeWithSignerWhitelist(
  instructions: TransactionInstruction[],
  payer: PublicKey,
  allowedSigners: Set<string>,
): TransactionInstruction[] {
  const keep = new Set<string>([payer.toBase58(), ...allowedSigners]);
  return instructions.map(ix => {
    const keys = ix.keys.map(k => ({
      pubkey: k.pubkey,
      isWritable: k.isWritable,
      isSigner: keep.has(k.pubkey.toBase58()),
    }));
    return new TransactionInstruction({
      programId: ix.programId,
      keys,
      data: ix.data,
    });
  });
}
