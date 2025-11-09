import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
} from '@solana/web3.js';
import { RUNTIME } from '../runtime.js';

export async function loadStaticLuts(
  connection: Connection,
): Promise<AddressLookupTableAccount[]> {
  if (!RUNTIME.useLut || RUNTIME.lutAddresses.length === 0) return [];
  const addresses = RUNTIME.lutAddresses.map((s) => new PublicKey(s));
  return loadLookupTableAccounts(connection, addresses);
}

export async function loadLookupTableAccounts(
  connection: Connection,
  addresses: PublicKey[],
): Promise<AddressLookupTableAccount[]> {
  if (addresses.length === 0) return [];
  const infos = await connection.getMultipleAccountsInfo(addresses);
  return infos.map((ai, i) => {
    if (!ai) throw new Error(`LUT not found: ${addresses[i].toBase58()}`);
    return new AddressLookupTableAccount({
      key: addresses[i],
      state: AddressLookupTableAccount.deserialize(ai.data),
    });
  });
}
