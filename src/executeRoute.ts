import { Connection, Keypair, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { buildAndMaybeLut } from './tx.js';
import { simulateWithLogs, sendAndConfirmAny } from './send.js';
import { CFG } from './config.js';

export async function executeRoute(
  connection: Connection,
  wallet: Keypair,
  ixs: TransactionInstruction[],
  priorityFeeMicroLamports: number,
) {
  const allInstructions: TransactionInstruction[] = [];

  if (CFG.cuLimit > 0) {
    allInstructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: CFG.cuLimit }));
  }
  if ((priorityFeeMicroLamports ?? 0) > 0) {
    allInstructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    );
  }

  allInstructions.push(...ixs);

  if (CFG.debugSim) {
    console.log('[route] instructions count =', allInstructions.length);
  }

  // The bot only controls the trader wallet. If any downstream instruction
  // requires another signer (e.g. a temporary wrap account produced by an
  // aggregator payload) we will never be able to authorize it, so detect that
  // early and bail out instead of submitting a transaction that will always
  // fail with MissingRequiredSignature.
  const unsupportedSignerKeys = new Set<string>();
  for (const ix of allInstructions) {
    for (const meta of ix.keys) {
      if (meta.isSigner && !meta.pubkey.equals(wallet.publicKey)) {
        unsupportedSignerKeys.add(meta.pubkey.toBase58());
      }
    }
  }

  if (unsupportedSignerKeys.size > 0) {
    const list = [...unsupportedSignerKeys];
    const msg = `[route] instruction requires unsupported signer(s): ${list.join(', ')}`;
    if (CFG.debugSim) {
      console.warn(msg);
    }
    const err = new Error(msg);
    (err as Error & { signers?: string[] }).signers = list;
    throw err;
  }

  const built = await buildAndMaybeLut(
    connection,
    wallet.publicKey,
    wallet,
    allInstructions,
    priorityFeeMicroLamports,
  );

  if ('lutAddressUsed' in built && (built as any).lutAddressUsed) {
    console.log('[lut] used', (built as any).lutAddressUsed.toBase58());
  }

  const sim = await simulateWithLogs(connection, built, [wallet]);
  if (sim.value.err) {
    const err = new Error('simulation failed') as Error & {
      getLogs?: () => Promise<string[] | null>;
    };
    err.getLogs = async () => sim.value.logs ?? null;
    throw err;
  } else {
    console.log('[sim] ok (no err)');
  }

  const sig = await sendAndConfirmAny(connection, built, [wallet]);
  return sig;
}
