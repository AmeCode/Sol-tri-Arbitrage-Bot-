import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

const EXTEND_CHUNK = 20;
const SLOT_COMMITMENT: Commitment = 'processed'; // freshest to avoid drift

function isNotRecentSlotErr(e: unknown): boolean {
  const msg = (e as any)?.message ?? String(e);
  return (
    msg.includes('is not a recent slot') ||
    msg.includes('InvalidInstructionData') // same preflight bucket on some RPCs
  );
}

async function fetchFreshSlot(connection: Connection): Promise<number> {
  // processed = minimize the chance the preflight node thinks it isn’t recent
  return await connection.getSlot(SLOT_COMMITMENT);
}

async function sendTxWithRetry(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  opts?: { allowSkipPreflightFallback?: boolean; label?: string }
): Promise<string> {
  // Try normal preflight first; if it throws a "not a recent slot", retry fresh.
  let lastErr: any = null;

  // Up to 2 “fresh” attempts
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, signers, {
        commitment: 'confirmed',
        skipPreflight: false,
      });
      return sig;
    } catch (e) {
      lastErr = e;
      if (!isNotRecentSlotErr(e)) throw e;
      // brief backoff then retry
      await new Promise((r) => setTimeout(r, 120));
    }
  }

  // Optional fallback: skip preflight (the chain will still reject if invalid)
  if (opts?.allowSkipPreflightFallback) {
    const sig = await connection.sendTransaction(tx, signers, {
      skipPreflight: true,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }

  throw lastErr;
}

export async function createLut(
  connection: Connection,
  payer: PublicKey,
  payerSigner: Keypair
) {
  // NOTE: createLookupTable requires a slot that’s “recent” by the time the TX
  // hits the validator. We fetch, build, and send immediately — and retry if
  // preflight claims it isn’t recent.
  for (let attempt = 0; attempt < 3; attempt++) {
    const slot = await fetchFreshSlot(connection);

    const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
      authority: payer,
      payer,
      recentSlot: slot,
    });

    const tx = new Transaction().add(createIx);
    tx.feePayer = payer;

    try {
      await sendTxWithRetry(connection, tx, [payerSigner], {
        allowSkipPreflightFallback: attempt >= 1, // skip preflight on 2nd+ try
        label: 'createLUT',
      });
      return lutAddress;
    } catch (e) {
      if (!isNotRecentSlotErr(e)) throw e;
      // try again with a fresh slot
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // If we’re here, every attempt looked “not recent” — this is almost always an
  // RPC sync problem. Surface a clear message so the caller can decide to
  // change endpoint or wait.
  throw new Error(
    'LUT create failed after retries due to "not a recent slot". Your RPC is likely out of sync; try a different endpoint.'
  );
}

export async function extendLut(
  connection: Connection,
  payer: PublicKey,
  payerSigner: Keypair,
  lutAddress: PublicKey,
  addKeys: PublicKey[]
) {
  for (let i = 0; i < addKeys.length; i += EXTEND_CHUNK) {
    const slice = addKeys.slice(i, i + EXTEND_CHUNK);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      authority: payer,
      payer,
      lookupTable: lutAddress,
      addresses: slice,
    });

    const tx = new Transaction().add(extendIx);
    tx.feePayer = payer;

    // Same retry policy as create
    await sendTxWithRetry(connection, tx, [payerSigner], {
      allowSkipPreflightFallback: true,
      label: 'extendLUT',
    });
  }
}

export async function ensureLutHas(
  connection: Connection,
  payer: PublicKey,
  payerSigner: Keypair,
  maybeLutAddr: PublicKey | null,
  requiredKeys: PublicKey[]
): Promise<PublicKey> {
  let lutAddr = maybeLutAddr;
  if (!lutAddr) {
    lutAddr = await createLut(connection, payer, payerSigner);
  }
  const lutAcc = (await connection.getAddressLookupTable(lutAddr)).value;
  const present = new Set((lutAcc?.state.addresses ?? []).map((k) => k.toBase58()));
  const toAdd = requiredKeys.filter((k) => !present.has(k.toBase58()));
  if (toAdd.length > 0) {
    await extendLut(connection, payer, payerSigner, lutAddr, toAdd);
  }
  return lutAddr;
}

// Build a v0 tx using a LUT + optional compute budget prelude
export async function buildV0WithLut(params: {
  connection: Connection;
  payer: PublicKey;
  lutAddress: PublicKey;
  cuLimit?: number;
  cuPriceMicroLamports?: number;
  instructions: TransactionInstruction[];
}) {
  const { connection, payer, lutAddress, instructions } = params;
  const lutAcc = (await connection.getAddressLookupTable(lutAddress)).value;
  if (!lutAcc) throw new Error('LUT not found on chain');

  const { blockhash } = await connection.getLatestBlockhash('finalized');
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message([lutAcc]);

  return new VersionedTransaction(msg);
}

