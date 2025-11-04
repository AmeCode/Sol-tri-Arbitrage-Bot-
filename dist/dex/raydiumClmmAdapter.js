// src/dex/raydiumClmmAdapter.ts
import { PublicKey, } from '@solana/web3.js';
import { Api, Percent, PoolInfoLayout, PoolUtils, Clmm, // note: we’ll feature-detect method names at runtime
 } from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';
import DecimalJs from 'decimal.js';
const DecimalCtor = DecimalJs;
const priceLimit0 = new DecimalCtor(0);
import { CFG } from '../config.js';
/**
 * Raydium CLMM edge:
 *  - Quote: PoolUtils.computeAmountOut (tick-array aware, no HTTP)
 *  - Execute: Clmm.makeSwapInstruction (or Legacy fallback)
 */
export function makeRayClmmEdge(poolId, mintA, mintB, connection) {
    const pid = new PublicKey(poolId);
    const api = new Api({ cluster: 'mainnet', timeout: 12_000 });
    function direction(from, to) {
        if (from === mintA && to === mintB)
            return { aToB: true };
        if (from === mintB && to === mintA)
            return { aToB: false };
        throw new Error(`raydium direction mismatch ${from} -> ${to}`);
    }
    async function fetchPoolAccount() {
        const acc = (await connection.getAccountInfo(pid));
        if (!acc)
            throw new Error('raydium: pool not found');
        const state = PoolInfoLayout.decode(acc.data);
        return { poolId: pid, ...state };
    }
    function isConcentratedPool(value) {
        if (!value || typeof value !== 'object')
            return false;
        const pool = value;
        return (pool.type === 'Concentrated' &&
            typeof pool.id === 'string' &&
            typeof pool.programId === 'string' &&
            typeof pool.mintA === 'string' &&
            typeof pool.mintB === 'string');
    }
    async function fetchApiPool() {
        const res = (await api.fetchPoolById({ ids: poolId }));
        const item = res.find((p) => isConcentratedPool(p) && p.id === poolId);
        if (!item)
            throw new Error(`raydium: api pool not found for ${poolId}`);
        return item;
    }
    async function buildComputeInputs() {
        const apiPool = await fetchApiPool();
        const rpcAcc = (await connection.getAccountInfo(pid));
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
        async quoteOut(amountIn) {
            await fetchPoolAccount(); // fast existence check
            const { computePool, tickArrayCache } = await buildComputeInputs();
            const epochInfo = await connection.getEpochInfo();
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
            return BigInt(out.amountOut.amount.toString());
        },
        /** Build CLMM swap ix; SDK v0.2.30-alpha exposes `makeSwapInstruction` (not Simple). */
        async buildSwapIx(amountIn, _minOut, user) {
            const { computePool } = await buildComputeInputs();
            const slippage = new Percent(CFG.maxSlippageBps, 10_000);
            const { aToB } = direction(this.from, this.to);
            const clmmAny = Clmm;
            let swapRes;
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
            }
            else if (typeof clmmAny.makeSwapInstructionLegacy === 'function') {
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
            }
            else {
                throw new Error('raydium: no CLMM swap builder found in this SDK build');
            }
            const ixs = [];
            for (const itx of swapRes.innerTransactions ?? []) {
                for (const ix of itx.instructions ?? [])
                    ixs.push(ix);
            }
            return ixs;
        },
    };
}
//# sourceMappingURL=raydiumClmmAdapter.js.map