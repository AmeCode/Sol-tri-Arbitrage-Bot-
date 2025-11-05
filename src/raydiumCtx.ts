import { Connection, Keypair } from "@solana/web3.js";
import { ApiV3 } from "@raydium-io/raydium-sdk-v2";

export async function initRaydiumCtx(rpcUrl: string) {
  const connection = new Connection(rpcUrl, "confirmed");
  const api = new ApiV3(); // uses Raydium API endpoints internally
  const wallet = { publicKey: Keypair.generate().publicKey }; // dummy for readonly
  return { api, connection, wallet };
}
