import 'dotenv/config';
import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';

async function main() {
  const endpoint = process.env.RPC_ENDPOINT ?? process.env.RPC_URL_SEND;
  if (!endpoint) throw new Error('RPC_ENDPOINT (or RPC_URL_SEND) missing');
  const secret = process.env.WALLET_SECRET;
  if (!secret) throw new Error('WALLET_SECRET missing');
  const lamportsEnv = process.env.LAMPORTS ?? '';
  if (!lamportsEnv) throw new Error('LAMPORTS missing');
  const lamports = BigInt(lamportsEnv);
  if (lamports <= 0n) throw new Error('LAMPORTS must be positive');
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('LAMPORTS exceeds safe number range for this helper');
  }

  const connection = new Connection(endpoint, 'confirmed');
  const wallet = Keypair.fromSecretKey(bs58.decode(secret));

  const ata = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  const tx = new Transaction();
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      ata,
      wallet.publicKey,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  tx.add(
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: ata,
      lamports: Number(lamports),
    }),
  );
  tx.add(createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID));

  const latest = await connection.getLatestBlockhash('finalized');
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(wallet);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
  console.log('[prep] wrap-wsol tx', sig);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
