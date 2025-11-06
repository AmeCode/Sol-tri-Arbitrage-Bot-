import {
  Connection,
  Keypair,
  Signer,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';

export type BuiltTx =
  | { kind: 'legacy'; tx: Transaction }
  | { kind: 'v0'; tx: VersionedTransaction };

export async function simulateWithLogs(
  connection: Connection,
  built: BuiltTx,
  signers: Signer[],
) {
  try {
    if (built.kind === 'legacy') {
      const tx = built.tx;
      // simulate accepts (legacy) partially signed; signers not required for sim
      const sim = await connection.simulateTransaction(tx, signers);
      return sim;
    } else {
      // Versioned: must be signed before simulateTransaction in some node/web3 combos
      const tx = built.tx;
      tx.sign(signers as Keypair[]);
      const sim = await connection.simulateTransaction(tx, { sigVerify: true });
      return sim;
    }
  } catch (e: any) {
    throw e;
  }
}

export async function sendAndConfirmAny(
  connection: Connection,
  built: BuiltTx,
  signers: Signer[],
) {
  if (built.kind === 'legacy') {
    // web3 will sign using provided signers internally
    const sig = await connection.sendTransaction(built.tx, signers, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
  } else {
    // Versioned must be signed explicitly
    const tx = built.tx;
    tx.sign(signers as Keypair[]);
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction(sig, 'confirmed');
    return sig;
  }
}
