import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Keypair,
} from '@solana/web3.js';

const EXTEND_CHUNK = 20;

export async function createLut(connection: Connection, payer: PublicKey, payerSigner: Keypair) {
  const slot = await connection.getSlot();
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer,
    payer,
    recentSlot: slot,
  });
  const tx = new Transaction().add(createIx);
  await sendAndConfirmTransaction(connection, tx, [payerSigner]);
  return lutAddress;
}

export async function extendLut(
  connection: Connection,
  payer: PublicKey,
  payerSigner: Keypair,
  lutAddress: PublicKey,
  addKeys: PublicKey[],
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
    await sendAndConfirmTransaction(connection, tx, [payerSigner]);
  }
}

export async function ensureLutHas(
  connection: Connection,
  payer: PublicKey,
  payerSigner: Keypair,
  maybeLutAddr: PublicKey | null,
  requiredKeys: PublicKey[],
): Promise<PublicKey> {
  let lutAddr = maybeLutAddr;
  if (!lutAddr) {
    lutAddr = await createLut(connection, payer, payerSigner);
  }
  const lutAcc = (await connection.getAddressLookupTable(lutAddr)).value;
  const present = new Set((lutAcc?.state.addresses ?? []).map(k => k.toBase58()));
  const toAdd = requiredKeys.filter(k => !present.has(k.toBase58()));
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
  const { connection, payer, lutAddress, cuLimit, cuPriceMicroLamports, instructions } = params;
  const prelude: TransactionInstruction[] = [];
  if (cuLimit && cuLimit > 0) {
    prelude.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  }
  if (cuPriceMicroLamports && cuPriceMicroLamports > 0) {
    prelude.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }));
  }

  const lutAcc = (await connection.getAddressLookupTable(lutAddress)).value;
  if (!lutAcc) throw new Error('LUT not found on chain');

  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...prelude, ...instructions],
  }).compileToV0Message([lutAcc]);

  return new VersionedTransaction(msg);
}
