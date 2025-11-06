import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Signer,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { CFG } from './config.js';
import { ensureLutHas } from './lut.js';
import { sanitizeWithSignerWhitelist } from './txSanitize.js';

let runtimeLutAddress: PublicKey | null = CFG.lutAddressEnv && CFG.lutAddressEnv.length > 0
  ? new PublicKey(CFG.lutAddressEnv)
  : null;

export function getRuntimeLutAddress(): PublicKey | null {
  return runtimeLutAddress;
}
export function setRuntimeLutAddress(addr: PublicKey) {
  runtimeLutAddress = addr;
}

export function withComputeBudget(
  ixs: TransactionInstruction[],
  cuLimit?: number,
  cuPriceMicroLamports?: number
) {
  const pre: TransactionInstruction[] = [];
  if (cuLimit && cuLimit > 0) {
    pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  }
  if (cuPriceMicroLamports && cuPriceMicroLamports > 0) {
    pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPriceMicroLamports }));
  }
  return [...pre, ...ixs];
}

export async function buildAndMaybeLut(
  connection: Connection,
  payer: PublicKey,
  payerSigner: Signer, // Keypair
  rawInstructions: TransactionInstruction[],
  cuPriceMicroLamports?: number,
  cuLimit?: number,
  extraSignerPubkeys: PublicKey[] = [],
): Promise<
  | { kind: 'legacy'; tx: Transaction; lutAddressUsed?: PublicKey }
  | { kind: 'v0'; tx: VersionedTransaction; lutAddressUsed?: PublicKey }
> {
  const allowed = new Set(extraSignerPubkeys.map(k => k.toBase58()));
  const sanitized = sanitizeWithSignerWhitelist(rawInstructions, payer, allowed);
  const withCb = withComputeBudget(sanitized, cuLimit ?? CFG.cuLimit, cuPriceMicroLamports);

  // 1) Try legacy first (fast path)
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    const legacy = new Transaction();
    legacy.recentBlockhash = blockhash;
    legacy.feePayer = payer;
    withCb.forEach(ix => legacy.add(ix));

    // serialize to ensure it fits; if too large, fallthrough to v0/LUT
    legacy.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { kind: 'legacy', tx: legacy };
  } catch {
    // too big → build v0 with LUT
  }

  // 2) v0 with LUT (collect all accounts)
  const keySet = new Set<string>();
  const requiredKeys: PublicKey[] = [];
  function add(k: PublicKey) {
    const s = k.toBase58();
    if (!keySet.has(s)) {
      keySet.add(s);
      requiredKeys.push(k);
    }
  }
  for (const ix of withCb) {
    add(ix.programId);
    for (const k of ix.keys) add(k.pubkey);
  }

  const ensured = await ensureLutHas(
    connection,
    payer,
    payerSigner as any,
    runtimeLutAddress,
    requiredKeys,
  );
  runtimeLutAddress = ensured;

  // Compile v0
  const lutAcc = (await connection.getAddressLookupTable(ensured)).value;
  if (!lutAcc) throw new Error('LUT not found on chain');
  const { blockhash } = await connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: withCb,
  }).compileToV0Message([lutAcc]);

  return { kind: 'v0', tx: new VersionedTransaction(msg), lutAddressUsed: ensured };
}
