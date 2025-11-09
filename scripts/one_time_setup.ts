import 'dotenv/config';
import fs from 'fs';
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  NATIVE_MINT,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? 'https://api.mainnet-beta.solana.com';
const KEYPAIR_PATH = process.env.KEYPAIR ?? './wallet/old-wallet.json';

// Update this list with every SPL mint you intend to trade.
const TOKENS = [
  // new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC
  // new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), // USDT
];

const WSOL_BUFFER_LAMPORTS = BigInt(process.env.WSOL_BUFFER_LAMPORTS ?? '200000000'); // 0.2 SOL default

function loadKeypair(): Keypair {
  const raw = fs.readFileSync(KEYPAIR_PATH, 'utf8');
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

async function ensureAtaInstructions(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  payer: PublicKey,
): Promise<{ ata: PublicKey; instructions: TransactionInstruction[] }> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const info = await connection.getAccountInfo(ata);
  if (info) return { ata, instructions: [] };
  const instruction = createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint);
  return { ata, instructions: [instruction] };
}

async function createLookupTable(connection: Connection, payer: Keypair) {
  const slot = await connection.getSlot();
  const [createIx, lutAddress] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: slot,
  });
  const extendIxs: ReturnType<typeof AddressLookupTableProgram.extendLookupTable>[] = [];

  const transaction = new Transaction().add(createIx);
  const sig = await sendAndConfirmTransaction(connection, transaction, [payer]);
  console.log(`[setup] LUT created ${lutAddress.toBase58()} (tx ${sig})`);

  if (extendIxs.length) {
    const extendTx = new Transaction();
    extendIxs.forEach((ix) => extendTx.add(ix.instruction));
    const extendSig = await sendAndConfirmTransaction(connection, extendTx, [payer]);
    console.log(`[setup] LUT extended (tx ${extendSig})`);
  }

  return lutAddress;
}

async function wrapWsol(connection: Connection, payer: Keypair, amount: bigint) {
  if (amount <= 0n) return;
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  const { instructions } = await ensureAtaInstructions(connection, payer.publicKey, NATIVE_MINT, payer.publicKey);
  const lamports = Number(amount);

  const tx = new Transaction();
  instructions.forEach((ix) => tx.add(ix));
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: ata, lamports }));
  tx.add(createSyncNativeInstruction(ata));

  const sig = await sendAndConfirmTransaction(connection, tx, [payer]);
  console.log(`[setup] wrapped ${lamports} lamports into WSOL ATA ${ata.toBase58()} (tx ${sig})`);
}

(async () => {
  const connection = new Connection(RPC_ENDPOINT, 'confirmed');
  const wallet = loadKeypair();

  console.log(`[setup] using wallet ${wallet.publicKey.toBase58()}`);

  const ataTx = new Transaction();
  const ataIxs = [];

  for (const mint of TOKENS) {
    const { ata, instructions } = await ensureAtaInstructions(connection, wallet.publicKey, mint, wallet.publicKey);
    if (instructions.length) {
      instructions.forEach((ix) => ataTx.add(ix));
      ataIxs.push({ mint: mint.toBase58(), ata: ata.toBase58() });
    } else {
      console.log(`[setup] ATA already exists for ${mint.toBase58()} (${ata.toBase58()})`);
    }
  }

  if (ataTx.instructions.length) {
    const sig = await sendAndConfirmTransaction(connection, ataTx, [wallet]);
    console.log(`[setup] created ATAs (tx ${sig})`, ataIxs);
  }

  if (WSOL_BUFFER_LAMPORTS > 0n) {
    await wrapWsol(connection, wallet, WSOL_BUFFER_LAMPORTS);
  }

  if ((process.env.CREATE_LUT ?? 'false') === 'true') {
    const lut = await createLookupTable(connection, wallet);
    console.log(`[setup] paste LUT address into LUT_ADDRESSES env: ${lut.toBase58()}`);
  }

  console.log('[setup] complete');
})();
