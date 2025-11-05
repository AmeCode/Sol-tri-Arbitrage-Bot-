// src/dex/raydiumClmmAdapter.ts
import {
  PublicKey,
  TransactionInstruction,
  AccountInfo,
  EpochInfo,
  Connection,
} from '@solana/web3.js';
import { Percent, PoolInfoLayout, PoolUtils, Clmm } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import DecimalJs from 'decimal.js';
// Create a strongly-typed constructor alias so TS treats it as new-able
type DecimalInstance = import('decimal.js').Decimal;
const DecimalCtor: new (v?: number | string | bigint) => DecimalInstance =
  DecimalJs as unknown as new (v?: number | string | bigint) => DecimalInstance;

const priceLimit0 = new DecimalCtor(0);
import { PoolEdge } from '../graph/types.js';
import { RayPoolInfo, RayPoolRegistry } from '../ray/api.js';
import { rayIndex } from '../initRay.js';

const poolRegistry = new RayPoolRegistry();
import { CFG } from '../config.js';

/**
 * Raydium CLMM edge:
 *  - Quote: PoolUtils.computeAmountOut (tick-array aware, no HTTP)
 *  - Execute: Clmm.makeSwapInstruction (or Legacy fallback)
 */
export function makeRayClmmEdge(
  poolId: string,
  mintA: string,
  mintB: string,
  connection: Connection
): PoolEdge {
  const pid = new PublicKey(poolId);
  const poolIdBase58 = pid.toBase58();

  function requireApiPool(id: string) {
    const apiPool = rayIndex.getById(id);
    if (!apiPool) {
      const debug = rayIndex.debugInfo(id);
      console.warn('[ray-edge] miss', { id, debug, note: 'ensure pool id exists in Ray CLMM API' });
      throw new Error(`raydium: api pool not found for ${id}`);
    }
    return apiPool;
  }

  function direction(from: string, to: string) {
    if (from === mintA && to === mintB) return { aToB: true };
    if (from === mintB && to === mintA) return { aToB: false };
    throw new Error(`raydium direction mismatch ${from} -> ${to}`);
  }

  type DecodedClmmPool = ReturnType<typeof PoolInfoLayout.decode> & { poolId: PublicKey };
  async function fetchPoolAccount(): Promise<DecodedClmmPool> {
    const acc = (await connection.getAccountInfo(pid)) as AccountInfo<Buffer> | null;
    if (!acc) throw new Error('raydium: pool not found');
    const state = PoolInfoLayout.decode(acc.data);
    return { poolId: pid, ...state };
  }

  async function fetchApiPool(): Promise<RayPoolInfo> {
    requireApiPool(poolIdBase58);

    const info = await poolRegistry.getById(poolIdBase58);
    if (info) return info;
    await poolRegistry.loadByIds([poolIdBase58]);
    const refreshed = await poolRegistry.getById(poolIdBase58);
    if (!refreshed) {
      console.warn('[ray-edge] fetchApiPool miss', {
        id: poolIdBase58,
        debug: rayIndex.debugInfo(poolIdBase58),
      });
      throw new Error(`raydium: api pool not found for ${poolIdBase58}`);
    }
    return refreshed;
  }

  async function buildComputeInputs() {
    const apiPool = await fetchApiPool();
    const rpcAcc = (await connection.getAccountInfo(pid)) as AccountInfo<Buffer> | null;
    const rpcData = rpcAcc ? PoolInfoLayout.decode(rpcAcc.data) : undefined;

    const computePool = await PoolUtils.fetchComputeClmmInfo({
      connection,
      poolInfo: {
        id: apiPool.id,
        programId: apiPool.programId,
        mintA: apiPool.mintA,
        mintB: apiPool.mintB,
        config: apiPool.config,
        price: apiPool.price,
      },
      rpcData,
    });

    const tickArraysByPool = await PoolUtils.fetchMultiplePoolTickArrays({
      connection,
      poolKeys: [computePool],
      batchRequest: true,
    });

    const tickArrayCache = tickArraysByPool[computePool.id.toBase58()] ?? {};
    return { computePool, tickArrayCache };
  }

  return {
    id: `ray:${poolId}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    /** Pure local quote using PoolUtils.computeAmountOut */
    async quoteOut(amountIn: bigint): Promise<bigint> {
      const indexed = requireApiPool(poolIdBase58);
      await fetchPoolAccount(); // fast existence check

      const { computePool, tickArrayCache } = await buildComputeInputs();
      const epochInfo: EpochInfo = await connection.getEpochInfo();

      const out = PoolUtils.computeAmountOut({
        poolInfo: computePool,
        tickArrayCache,
        baseMint: new PublicKey(this.from),
        epochInfo,
        amountIn: new BN(amountIn.toString()),
        slippage: CFG.maxSlippageBps / 10_000, // expects ratio
        priceLimit: priceLimit0,
        catchLiquidityInsufficient: true,
      });

      const amountOut = BigInt(out.amountOut.amount.toString());
      if (amountOut <= 0n) {
        console.warn('[ray-edge] non-positive quote', {
          poolId: indexed.id ?? poolIdBase58,
          pair: `${mintA}->${mintB}`,
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
          debug: rayIndex.debugInfo(poolIdBase58),
        });
        throw new Error('raydium: non-positive quote');
      }
      return amountOut;
    },

    /** Build CLMM swap ix; SDK v0.2.30-alpha exposes `makeSwapInstruction` (not Simple). */
    async buildSwapIx(
      amountIn: bigint,
      _minOut: bigint,
      user: PublicKey
    ): Promise<TransactionInstruction[]> {
      requireApiPool(poolIdBase58);
      const { computePool } = await buildComputeInputs();
      const slippage = new Percent(CFG.maxSlippageBps, 10_000);
      const { aToB } = direction(this.from, this.to);

      const clmmAny = Clmm as unknown as Record<string, any>;

      let swapRes: { innerTransactions?: { instructions?: TransactionInstruction[] }[] };

      if (typeof clmmAny.makeSwapInstruction === 'function') {
        // Current in 0.2.30-alpha
        swapRes = await clmmAny.makeSwapInstruction({
          connection,
          poolInfo: computePool,
          ownerInfo: { useSOLBalance: true, wallet: user },
          inputMint: new PublicKey(this.from),
          inputAmount: new BN(amountIn.toString()),
          slippage,
          aToB,
          makeTxVersion: 0,
        });
      } else if (typeof clmmAny.makeSwapInstructionLegacy === 'function') {
        // Older prereleases
        swapRes = await clmmAny.makeSwapInstructionLegacy({
          connection,
          poolInfo: computePool,
          ownerInfo: { useSOLBalance: true, wallet: user },
          inputMint: new PublicKey(this.from),
          inputAmount: new BN(amountIn.toString()),
          slippage,
          aToB,
          makeTxVersion: 0,
        });
      } else {
        throw new Error('raydium: no CLMM swap builder found in this SDK build');
      }

      const ixs: TransactionInstruction[] = [];
      for (const itx of swapRes.innerTransactions ?? []) {
        for (const ix of itx.instructions ?? []) ixs.push(ix);
      }
      return ixs;
    },
  };
}

