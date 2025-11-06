import {
  Connection,
  Keypair,
  Signer,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { CFG } from './config.js';

type BuiltTx =
  | { kind: 'legacy'; tx: Transaction }
  | { kind: 'v0'; tx: VersionedTransaction };

export async function simulateWithLogs(
  connection: Connection,
  built: BuiltTx,
  signers: Signer[],
) {
  if (CFG.debugSim) console.log('[sim] starting simulateWithLogs… kind=', built.kind);

  try {
    if (built.kind === 'legacy') {
      const sim = await connection.simulateTransaction(built.tx, signers);
      if (CFG.debugSim) {
        console.log('[sim] legacy result err=', sim.value.err);
        if (sim.value.logs) {
          console.log('[sim logs]');
          sim.value.logs.forEach((l, i) => console.log(String(i).padStart(2, '0'), l));
        }
      }
      return sim;
    } else {
      // Versioned must be signed for some RPC/node combos to return logs
      const tx = built.tx;
      tx.sign(signers as Keypair[]);
      const sim = await connection.simulateTransaction(tx, { sigVerify: true });
      if (CFG.debugSim) {
        console.log('[sim] v0 result err=', sim.value.err);
        if (sim.value.logs) {
          console.log('[sim logs]');
          sim.value.logs.forEach((l, i) => console.log(String(i).padStart(2, '0'), l));
        }
      }
      return sim;
    }
  } catch (e: any) {
    console.error('[sim] threw:', e?.message ?? e);
    throw e;
  }
}

export async function sendAndConfirmAny(
  connection: Connection,
  built: BuiltTx,
  signers: Signer[],
) {
  if (CFG.debugSim) console.log('[send] sending kind=', built.kind);

  if (built.kind === 'legacy') {
    const sig = await connection.sendTransaction(built.tx, signers, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(sig, 'confirmed');
    console.log('[send] sig', sig);
    return sig;
  } else {
    const tx = built.tx;
    tx.sign(signers as Keypair[]);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(sig, 'confirmed');
    console.log('[send] sig', sig);
    return sig;
  }
}
