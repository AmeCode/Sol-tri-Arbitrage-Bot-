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
  try {
    if (built.kind === 'legacy') {
      // 👉 Always sign legacy before simulate
      const tx = built.tx as Transaction;
      tx.sign(...(signers as Keypair[]));
      const sim = await connection.simulateTransaction(tx, signers as Keypair[]);
      if (CFG.debugSim) {
        console.log('[sim] legacy err=', sim.value.err);
        sim.value.logs?.forEach((l, i) => console.log(String(i).padStart(2, '0'), l));
      }
      return sim;
    } else {
      // 👉 Always sign v0 before simulate
      const tx = built.tx as VersionedTransaction;
      tx.sign(signers as Keypair[]);
      const sim = await connection.simulateTransaction(tx, {
        sigVerify: true,
        commitment: 'processed',
      });
      if (CFG.debugSim) {
        console.log('[sim] v0 err=', sim.value.err);
        sim.value.logs?.forEach((l, i) => console.log(String(i).padStart(2, '0'), l));
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
  if (built.kind === 'legacy') {
    (built.tx as Transaction).sign(...(signers as Keypair[]));
    const sig = await connection.sendRawTransaction(built.tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(sig, 'confirmed');
    console.log('[send] sig', sig);
    return sig;
  } else {
    const tx = built.tx as VersionedTransaction;
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
