import {
  Connection,
  Keypair,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { buildAndMaybeLut } from './tx.js';
import { sendAndConfirmAny, simulateWithLogs } from './send.js';
import { CFG } from './config.js';

export async function executeRoute(
  connection: Connection,
  payer: Keypair,
  hop1: TransactionInstruction,
  hop2?: TransactionInstruction,
  hop3?: TransactionInstruction,
  priFeeMicroLamports?: number,
) {
  const ixs: TransactionInstruction[] = [];

  // Prelude: compute tweaks
  if (CFG.cuLimit > 0) {
    ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: CFG.cuLimit }));
  }
  if ((priFeeMicroLamports ?? 0) > 0) {
    ixs.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priFeeMicroLamports! }));
  }

  // Hops
  ixs.push(hop1);
  if (hop2) ixs.push(hop2);
  if (hop3) ixs.push(hop3);

  if (CFG.debugSim) {
    console.log('[route] instructions count =', ixs.length);
  }

  const built = await buildAndMaybeLut(
    connection,
    payer.publicKey,
    payer,
    ixs,
    priFeeMicroLamports,
  );

  // helpful banner
  if ('lutAddressUsed' in built && (built as any).lutAddressUsed) {
    console.log('[lut] used', (built as any).lutAddressUsed.toBase58());
  }

  // SIMULATE (always prints banners due to CFG.debugSim)
  const sim = await simulateWithLogs(connection, built, [payer]);
  if (sim.value.err) {
    console.error('[sim] err', sim.value.err);
    throw new Error('simulation failed');
  } else {
    console.log('[sim] ok (no err)');
  }

  // SEND
  const sig = await sendAndConfirmAny(connection, built, [payer]);
  return sig;
}
