import {
  Connection,
  PublicKey,
  Signer,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { CFG } from './config.js';
import { buildV0WithLut, ensureLutHas } from './lut.js';

let runtimeLutAddress: PublicKey | null = CFG.lutAddressEnv && CFG.lutAddressEnv.length > 0
  ? new PublicKey(CFG.lutAddressEnv)
  : null;

export function getRuntimeLutAddress(): PublicKey | null {
  return runtimeLutAddress;
}

export function setRuntimeLutAddress(addr: PublicKey) {
  runtimeLutAddress = addr;
}

export async function buildAndMaybeLut(
  connection: Connection,
  payer: PublicKey,
  payerSigner: Signer, // Keypair (or compatible) that can sign LUT txs if needed
  instructions: TransactionInstruction[],
  cuPriceMicroLamports: number | undefined,
): Promise<
  | { kind: 'legacy'; tx: Transaction; lutAddressUsed?: PublicKey }
  | { kind: 'v0'; tx: VersionedTransaction; lutAddressUsed?: PublicKey }
> {
  // 1) Try legacy (fast path, minimal overhead)
  try {
    const { blockhash } = await connection.getLatestBlockhash();
    const legacy = new Transaction();
    legacy.recentBlockhash = blockhash;
    legacy.feePayer = payer;
    for (const ix of instructions) legacy.add(ix);

    // Quick “dry” serialization: if this throws, it’s too big
    legacy.serialize({ requireAllSignatures: false, verifySignatures: false });
    return { kind: 'legacy', tx: legacy };
  } catch (e) {
    // too large → fall through to LUT/v0 path
  }

  // 2) Build with LUT
  // Collect **all** keys from instructions (accounts + programIds)
  const keySet = new Set<string>();
  const requiredKeys: PublicKey[] = [];
  function addKey(k: PublicKey) {
    const s = k.toBase58();
    if (!keySet.has(s)) {
      keySet.add(s);
      requiredKeys.push(k);
    }
  }
  for (const ix of instructions) {
    addKey(ix.programId);
    for (const k of ix.keys) addKey(k.pubkey);
  }

  // Resolve or create LUT
  const ensured = await ensureLutHas(
    connection,
    payer,
    payerSigner as any,
    runtimeLutAddress,
    requiredKeys,
  );
  runtimeLutAddress = ensured;

  const txV0 = await buildV0WithLut({
    connection,
    payer,
    lutAddress: ensured,
    cuLimit: CFG.cuLimit,
    cuPriceMicroLamports: cuPriceMicroLamports ?? 0,
    instructions,
  });

  return { kind: 'v0', tx: txV0, lutAddressUsed: ensured };
}
