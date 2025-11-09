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

import { RUNTIME } from './runtime.js';

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

  const ixs: TransactionInstruction[] = [];
  const shouldAllocate =
    RUNTIME.mode === 'live' && RUNTIME.requirePrealloc === false;
  if (shouldAllocate) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        ata,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  return { ata, ixs };
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
  if (RUNTIME.mode === 'simulate') {
    throw new Error(
      'simulate: wrapSolIntoAta disabled; pre-create & pre-fund WSOL ATA',
    );
  }

  const ensured = ensureAtaIx(payer, owner, NATIVE_MINT);
  if (RUNTIME.wsolPrewrap) {
    // Pre-wrapped WSOL should already be funded via prep script.
    return { ata: ensured.ata, ixs: [] };
  }

  const ixs = [...ensured.ixs];
  ixs.push(
    SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: ensured.ata,
      lamports: Number(amountLamports),
    }),
  );
  ixs.push(createSyncNativeInstruction(ensured.ata, TOKEN_PROGRAM_ID));
  return { ata: ensured.ata, ixs };
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
