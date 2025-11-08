import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Signer,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { CFG } from './config.js';
import { buildV0WithLut, ensureLutHas } from './lut.js';
import { assertNoUnwhitelistedAllocations } from './txGuards.js';
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
  dexLookupTables: PublicKey[] = [],
  includeRuntimeLut = true,
): Promise<
  | { kind: 'legacy'; tx: Transaction; lutAddressUsed?: PublicKey }
  | { kind: 'v0'; tx: VersionedTransaction; lutAddressUsed?: PublicKey }
> {
  // 0) Guard BEFORE sanitize so errors point at the offending ix clearly
  const allowed = new Set(extraSignerPubkeys.map(k => k.toBase58()));
  assertNoUnwhitelistedAllocations(rawInstructions, payer, allowed);

  const sanitized = sanitizeWithSignerWhitelist(rawInstructions, payer, allowed);
  const targetCuLimit = cuLimit ?? CFG.cuLimit;
  const withCb = withComputeBudget(sanitized, targetCuLimit, cuPriceMicroLamports);

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

  let ensured: PublicKey | null = null;
  if (includeRuntimeLut) {
    const keySet = new Set<string>();
    const requiredKeys: PublicKey[] = [];
    const add = (k: PublicKey) => {
      const s = k.toBase58();
      if (!keySet.has(s)) {
        keySet.add(s);
        requiredKeys.push(k);
      }
    };
    for (const ix of withCb) {
      add(ix.programId);
      for (const k of ix.keys) add(k.pubkey);
    }

    ensured = await ensureLutHas(
      connection,
      payer,
      payerSigner as any,
      runtimeLutAddress,
      requiredKeys,
    );
    runtimeLutAddress = ensured;
  }
  const tx = await buildV0WithLut({
    connection,
    payer,
    lutAddress: includeRuntimeLut && ensured ? ensured : undefined,
    dexLookupTables,
    cuLimit: targetCuLimit,
    cuPriceMicroLamports,
    instructions: sanitized,
  });

  return {
    kind: 'v0',
    tx,
    lutAddressUsed: includeRuntimeLut && ensured ? ensured : undefined,
  };
}
