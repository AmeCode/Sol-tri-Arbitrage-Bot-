import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import BN from "bn.js";
import { Clmm, PoolUtils } from "@raydium-io/raydium-sdk-v2";
import { PoolEdge } from "../graph/types.js";
import { bigIntToBN } from "../amounts.js";
import { CFG } from "../config.js";

type RawApiPool = {
  id: string;
  programId: string;
  type?: string;
  price?: number;
  mintA?: { address: string; [key: string]: unknown };
  mintB?: { address: string; [key: string]: unknown };
  config?: { id: string; [key: string]: unknown };
  [key: string]: unknown;
};

type ClmmApiPool = RawApiPool & {
  type: "Concentrated";
  price: number;
  mintA: { address: string; [key: string]: unknown };
  mintB: { address: string; [key: string]: unknown };
  config: { id: string; [key: string]: unknown };
};

function isClmmPool(pool: RawApiPool | undefined): pool is ClmmApiPool {
  return (
    !!pool &&
    pool.type === "Concentrated" &&
    typeof pool.price === "number" &&
    !!pool.mintA?.address &&
    !!pool.mintB?.address &&
    !!pool.config?.id
  );
}

/**
 * You must have an SDK wrapper that exposes:
 * - raydium.connection  (web3.js Connection)
 * - raydium.wallet      (payer or dummy readonly)
 * - raydium.api         (Raydium Api instance)
 * Create it once and pass in via makeRaydiumClmmEdge(..., raydium)
 */
export type RaydiumCtx = {
  api: { fetchPoolById: (props: { ids: string }) => Promise<RawApiPool[]> };
  connection: Connection;
  wallet: { publicKey: PublicKey };
};

export function makeRaydiumClmmEdge(
  poolId: string,
  mintA: string,
  mintB: string,
  raydium: RaydiumCtx
): PoolEdge {
  function getInputMint(from: string) {
    if (from === mintA) return new PublicKey(mintA);
    if (from === mintB) return new PublicKey(mintB);
    throw new Error(`raydium clmm: direction mismatch: from=${from} not in [${mintA}, ${mintB}]`);
  }

  async function loadPoolData() {
    const [poolInfo] = await raydium.api.fetchPoolById({ ids: poolId });
    if (!isClmmPool(poolInfo)) {
      console.warn(`[raydium] pool ${poolId} missing or not concentrated`);
      return null;
    }

    const clmmInfo = await PoolUtils.fetchComputeClmmInfo({
      connection: raydium.connection,
      poolInfo: poolInfo as any,
    });

    const { ammConfig: _ammConfig, ...poolState } = clmmInfo;
    const tickArrayMap = await PoolUtils.fetchMultiplePoolTickArrays({
      connection: raydium.connection,
      poolKeys: [poolState],
      batchRequest: true,
    });

    const tickArrayCache = tickArrayMap[clmmInfo.id.toBase58()] ?? {};

    return { apiPool: poolInfo, clmmInfo, tickArrayCache };
  }

  return {
    id: `ray:${poolId}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    /** Quote using PoolUtils.* helpers (BN amounts). */
    async quoteOut(amountIn: bigint): Promise<bigint> {
      try {
        const poolData = await loadPoolData();
        if (!poolData) {
          console.warn(`[raydium] api pool not found for ${poolId}`);
          return 0n;
        }
        const { apiPool, clmmInfo, tickArrayCache } = poolData;

        const inputMint = getInputMint(this.from);

        const inMintStr = inputMint.toBase58();
        const inBn = bigIntToBN(amountIn);
        const baseIn = inMintStr === apiPool.mintA.address;
        const tokenOut = baseIn ? apiPool.mintB : apiPool.mintA;
        const epochInfo = await raydium.connection.getEpochInfo();

        const compute = PoolUtils.computeAmountOutFormat({
          poolInfo: clmmInfo,
          tickArrayCache,
          amountIn: inBn,
          tokenOut,
          slippage: CFG.maxSlippageBps / 10_000,
          epochInfo,
          catchLiquidityInsufficient: true,
        });

        const outAmount = compute.amountOut?.amount.raw;
        if (!outAmount || outAmount.lte(new BN(0))) return 0n;
        return BigInt(outAmount.toString());
      } catch (e) {
        console.warn(`[raydium] quote error ${poolId}:`, (e as Error).message);
        return 0n;
      }
    },

    /** Build a swap ix (simplified): convert the quote to a tx via Clmm.makeSwapInstruction */
    async buildSwapIx(amountIn: bigint, minOut: bigint, user: PublicKey): Promise<TransactionInstruction[]> {
      try {
        const poolData = await loadPoolData();
        if (!poolData) {
          console.warn(`[raydium] api pool not found for ${poolId}`);
          return [];
        }
        const { clmmInfo } = poolData;

        const inputMint = getInputMint(this.from).toBase58();

        const minOutBn = new BN(minOut.toString(), 10);

        const { innerTransaction } = await Clmm.makeSwapInstructionSimple({
          connection: raydium.connection,
          poolInfo: clmmInfo,
          ownerInfo: {
            wallet: user,
            tokenAccounts: [], // fill with user's SPL accounts if you assemble full tx here
          },
          inputMint,
          amountIn: bigIntToBN(amountIn),
          amountOutMin: minOutBn,
          // tick arrays & remaining accounts can be passed or recomputed by helper
        });

        return innerTransaction.instructions;
      } catch (e) {
        console.warn(`[raydium] buildSwapIx error ${poolId}:`, (e as Error).message);
        return [];
      }
    },
  };
}
