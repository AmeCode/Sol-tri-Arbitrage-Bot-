import {
  AddressLookupTableAccount,
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

async function resolveLookupTables(
  connection: Connection,
  addrs: string[],
): Promise<{
  accounts: AddressLookupTableAccount[];
  missing: string[];
  stale: string[];
}> {
  const accounts: AddressLookupTableAccount[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const addr of addrs) {
    let key: PublicKey;
    try {
      key = new PublicKey(addr);
    } catch (e) {
      console.warn('[lut] invalid LUT address', addr, e);
      missing.push(addr);
      continue;
    }
    const acc = (await connection.getAddressLookupTable(key)).value;
    if (!acc) {
      console.warn('[lut] skip missing LUT', addr);
      missing.push(addr);
      continue;
    }
    if (typeof acc.isActive === 'function' && !acc.isActive()) {
      console.warn('[lut] skip stale LUT', addr);
      stale.push(addr);
      continue;
    }
    accounts.push(acc);
  }
  return { accounts, missing, stale };
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
  const lutAddressOrder: string[] = [];
  const seen = new Set<string>();
  for (const pk of dexLookupTables) {
    const s = pk.toBase58();
    if (!seen.has(s)) {
      seen.add(s);
      lutAddressOrder.push(s);
    }
  }
  if (includeRuntimeLut && ensured) {
    const runtimeKey = ensured.toBase58();
    if (!seen.has(runtimeKey)) {
      seen.add(runtimeKey);
      lutAddressOrder.push(runtimeKey);
    }
  }

  const { accounts: lutAccounts, missing, stale } = await resolveLookupTables(
    connection,
    lutAddressOrder,
  );
  const hadFailures = missing.length > 0 || stale.length > 0;
  const forcedNoLut = process.env.NO_DEX_LUT === '1';
  const useNoLut = forcedNoLut || lutAccounts.length === 0 || hadFailures;

  if (forcedNoLut) {
    console.warn('[lut] NO_DEX_LUT=1 forcing legacy compile');
  } else if (hadFailures) {
    console.warn('[lut] falling back to legacy compile', {
      missing,
      stale,
    });
  }

  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: withCb,
  });

  if (useNoLut) {
    const legacyMsg = message.compileToLegacyMessage();
    return {
      kind: 'v0',
      tx: new VersionedTransaction(legacyMsg),
      lutAddressUsed: undefined,
    };
  }

  const v0Msg = message.compileToV0Message(lutAccounts);
  const usedKeys = lutAccounts.map((acc) => acc.key.toBase58());
  if (usedKeys.length > 0) {
    console.log('[lut] using tables', usedKeys);
  }

  const runtimeUsed =
    includeRuntimeLut &&
    ensured &&
    lutAccounts.some((acc) => acc.key.equals(ensured));

  return {
    kind: 'v0',
    tx: new VersionedTransaction(v0Msg),
    lutAddressUsed: runtimeUsed ? ensured! : undefined,
  };
}
