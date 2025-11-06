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
