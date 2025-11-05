import { Connection, Keypair } from "@solana/web3.js";
import { Api } from "@raydium-io/raydium-sdk-v2";

type Cluster = "mainnet" | "devnet";

export type InitRaydiumCtxOpts = {
  cluster?: Cluster;
  apiTimeoutMs?: number;
  logRequests?: boolean;
  logCount?: number;
};

export async function initRaydiumCtx(rpcUrl: string, opts: InitRaydiumCtxOpts = {}) {
  const connection = new Connection(rpcUrl, "confirmed");

  const {
    cluster = "mainnet",
    apiTimeoutMs = 10_000,
    logRequests = false,
    logCount = 1000,
  } = opts;

  const api = new Api({
    cluster,
    timeout: apiTimeoutMs,
    logRequests,
    logCount,
  });

  const wallet = { publicKey: Keypair.generate().publicKey }; // dummy for readonly
  return { api, connection, wallet };
}
