import 'dotenv/config';
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const CHUNK = 20;

async function sendTx(connection: Connection, tx: Transaction, signer: Keypair, label: string) {
  const latest = await connection.getLatestBlockhash('finalized');
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
  console.log(`[prep:${label}]`, sig);
}

async function main() {
  const endpoint = process.env.RPC_ENDPOINT ?? process.env.RPC_URL_SEND;
  if (!endpoint) throw new Error('RPC_ENDPOINT (or RPC_URL_SEND) missing');
  const secret = process.env.WALLET_SECRET;
  if (!secret) throw new Error('WALLET_SECRET missing');

  const keys = (process.env.LUT_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new PublicKey(s));

  const connection = new Connection(endpoint, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(secret));

  const slot = await connection.getSlot('processed');
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: wallet.publicKey,
    payer: wallet.publicKey,
    recentSlot: slot,
  });

  await sendTx(connection, new Transaction().add(createIx), wallet, 'create-lut');

  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    if (!chunk.length) continue;
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      lookupTable: lutAddress,
      payer: wallet.publicKey,
      authority: wallet.publicKey,
      addresses: chunk,
    });
    await sendTx(connection, new Transaction().add(extendIx), wallet, `extend-${i / CHUNK}`);
  }

  console.log('[prep] LUT ready at', lutAddress.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
