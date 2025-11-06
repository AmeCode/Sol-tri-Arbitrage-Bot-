import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

/**
 * Ensure owner's ATA for a mint. Returns the ATA pubkey + optional create ix.
 */
export function ensureAtaIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): { ata: PublicKey; ixs: TransactionInstruction[] } {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  const createIx = createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ata,
    owner,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return { ata, ixs: [createIx] };
}

/**
 * Prepare WSOL in owner's ATA (wrap). No extra signer required.
 * amountLamports is the *exact* amount you need available as WSOL for the hop.
 */
export function wrapSolIntoAta(
  payer: PublicKey,
  owner: PublicKey,
  amountLamports: bigint,
): { ata: PublicKey; ixs: TransactionInstruction[] } {
  const { ata, ixs } = ensureAtaIx(payer, owner, NATIVE_MINT);
  ixs.push(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: ata,
      lamports: Number(amountLamports),
    }),
  );
  ixs.push(createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID));
  return { ata, ixs };
}

/**
 * Optional: unwrap WSOL at the end (sends lamports back to owner).
 * Only do this after your last hop if you truly want SOL, not WSOL balance.
 */
export function unwrapWsolAta(
  owner: PublicKey,
): (ata?: PublicKey) => TransactionInstruction[] {
  return (ata?: PublicKey) => {
    if (!ata) return [];
    return [
      createCloseAccountInstruction(ata, owner, owner, [], TOKEN_PROGRAM_ID),
    ];
  };
}
