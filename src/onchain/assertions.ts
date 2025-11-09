import { Connection, PublicKey } from '@solana/web3.js';

export async function mustAccount(
  connection: Connection,
  pk: PublicKey,
  label: string,
) {
  const info = await connection.getAccountInfo(pk);
  if (!info) {
    throw new Error(`${label} not found on-chain: ${pk.toBase58()}`);
  }
  return info;
}
