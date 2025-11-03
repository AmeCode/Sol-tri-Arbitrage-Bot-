// src/jito.ts
import { Keypair } from '@solana/web3.js';
import { searcherClient, type SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';

export type JitoClient = SearcherClient;

/** Create a Searcher client for Jito Block Engine (no auth key needed). */
export function makeJitoClient(blockEngineUrl: string, _auth?: Keypair): JitoClient {
  if (!blockEngineUrl) throw new Error('BLOCK_ENGINE_URL missing');
  // Pass undefined for auth to use public access
  return searcherClient(blockEngineUrl, undefined as any);
}

