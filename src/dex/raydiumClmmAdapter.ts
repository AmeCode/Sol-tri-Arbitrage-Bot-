import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { CFG } from '../config.js';
import { PoolEdge } from '../graph/types.js';

type HttpRouteReq = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  tradeType: 'EXACT_INPUT';
  dexes?: string[];
};

type HttpRouteResp = {
  id: string;
  inAmount: string;
  outAmount: string;
};

type HttpSwapBuildReq = {
  routeId: string;
  userPublicKey: string;
  wrapAndUnwrapSol: boolean;
  computeUnitPriceMicroLamports?: number;
};

type HttpSwapBuildResp = {
  transaction: string;
};

async function postJson<T>(url: string, body: any): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[raydium-api] ${res.status} ${text}`);
  }

  return (await res.json()) as T;
}

async function loadLookupAccounts(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<AddressLookupTableAccount[]> {
  const message = tx.message;
  if (!('addressTableLookups' in message) || message.addressTableLookups.length === 0) {
    return [];
  }

  const lookupAddresses = message.addressTableLookups.map(l => l.accountKey);
  const accounts = await connection.getMultipleAccountsInfo(lookupAddresses);

  return lookupAddresses.map((key, idx) => {
    const info = accounts[idx];
    if (!info) {
      throw new Error(`[raydium] missing address lookup table ${key.toBase58()}`);
    }
    const state = AddressLookupTableAccount.deserialize(info.data);
    return new AddressLookupTableAccount({ key, state });
  });
}

export function makeRayClmmEdge(opts: {
  poolId: string;
  aMint: string;
  bMint: string;
  side: 'AtoB' | 'BtoA';
  connection: Connection;
}): PoolEdge {
  const id = new PublicKey(opts.poolId).toBase58();
  const inputMint = opts.side === 'AtoB' ? opts.aMint : opts.bMint;
  const outputMint = opts.side === 'AtoB' ? opts.bMint : opts.aMint;

  return {
    id: `ray:${id}`,
    from: inputMint,
    to: outputMint,
    feeBps: 0,

    async quoteOut(amountIn: bigint): Promise<bigint> {
      if (amountIn <= 0n) throw new Error('raydium: non-positive amountIn');
      const body: HttpRouteReq = {
        inputMint,
        outputMint,
        amount: amountIn.toString(),
        slippageBps: CFG.maxSlippageBps ?? 20,
        tradeType: 'EXACT_INPUT',
        dexes: ['RAYDIUM_CLMM'],
      };
      const route = await postJson<HttpRouteResp>(`${CFG.raydiumApiBase}/v2/route`, body);
      if (!route?.outAmount) {
        throw new Error(`[raydium] route missing outAmount for ${id}`);
      }
      return BigInt(route.outAmount);
    },

    async buildSwapIx(amountIn: bigint, minOut: bigint, user: PublicKey): Promise<TransactionInstruction[]> {
      const route = await postJson<HttpRouteResp>(`${CFG.raydiumApiBase}/v2/route`, {
        inputMint,
        outputMint,
        amount: amountIn.toString(),
        slippageBps: CFG.maxSlippageBps ?? 20,
        tradeType: 'EXACT_INPUT',
        dexes: ['RAYDIUM_CLMM'],
      });
      if (!route?.id) {
        throw new Error('[raydium] route.id missing');
      }

      const routeOut = route.outAmount ? BigInt(route.outAmount) : 0n;
      if (routeOut < minOut) {
        throw new Error(`[raydium] route outAmount ${routeOut} < minOut ${minOut}`);
      }

      const buildReq: HttpSwapBuildReq = {
        routeId: route.id,
        userPublicKey: user.toBase58(),
        wrapAndUnwrapSol: true,
      };
      if (CFG.cuPriceMicroLamports > 0) {
        buildReq.computeUnitPriceMicroLamports = CFG.cuPriceMicroLamports;
      }

      const built = await postJson<HttpSwapBuildResp>(
        `${CFG.raydiumApiBase}/v2/transaction/swap`,
        buildReq,
      );

      const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, 'base64'));
      const lookupAccounts = await loadLookupAccounts(opts.connection, tx);
      const message = tx.message;
      const accountKeys = message.getAccountKeys({
        addressLookupTableAccounts: lookupAccounts.length > 0 ? lookupAccounts : undefined,
      });

      return message.compiledInstructions.map(ci => {
        const programId = accountKeys.get(ci.programIdIndex);
        if (!programId) throw new Error('[raydium] missing program id in compiled instruction');

        const keys = ci.accountKeyIndexes.map(index => {
          const pubkey = accountKeys.get(index);
          if (!pubkey) throw new Error('[raydium] missing account key in compiled instruction');
          return {
            pubkey,
            isSigner: message.isAccountSigner(index),
            isWritable: message.isAccountWritable(index),
          };
        });

        return new TransactionInstruction({
          programId,
          keys,
          data: Buffer.from(ci.data),
        });
      });
    },
  };
}
