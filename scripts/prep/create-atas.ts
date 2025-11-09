import 'dotenv/config';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { ensureAtaIx } from '../../src/tokenAta.js';
import { withRuntimeMode } from '../../src/runtime.js';

async function main() {
  const endpoint = process.env.RPC_ENDPOINT ?? process.env.RPC_URL_SEND;
  if (!endpoint) throw new Error('RPC_ENDPOINT (or RPC_URL_SEND) missing');
  const secret = process.env.WALLET_SECRET;
  if (!secret) throw new Error('WALLET_SECRET missing');

  const mintList = (process.env.MINTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (mintList.length === 0) {
    throw new Error('Provide comma-separated mint list via MINTS env');
  }

  const connection = new Connection(endpoint, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(secret));

  await withRuntimeMode('live', async () => {
    const tx = new Transaction();
    for (const mintStr of mintList) {
      const mint = new PublicKey(mintStr);
      const ensured = ensureAtaIx(wallet.publicKey, wallet.publicKey, mint);
      ensured.ixs.forEach((ix) => tx.add(ix));
      console.log('[prep] ensure ATA for', mint.toBase58());
    }

    if (tx.instructions.length === 0) {
      console.log('[prep] all ATAs already exist (no instructions to send)');
      return;
    }

    const latest = await connection.getLatestBlockhash('finalized');
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = latest.blockhash;
    tx.sign(wallet);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
    console.log('[prep] create-atas tx', sig);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
