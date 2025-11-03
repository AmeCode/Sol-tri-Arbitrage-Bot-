import 'dotenv/config';
function parseBigints(csv) {
    return csv.split(',').map(s => BigInt(s.trim()));
}
export const CFG = {
    walletSecret: process.env.WALLET_SECRET,
    // Dual RPC
    rpcRead: process.env.RPC_URL_READ,
    rpcSend: process.env.RPC_URL_SEND,
    // Jito
    jitoRpc: process.env.JITO_RPC,
    // Jupiter
    jupiterBase: process.env.JUPITER_BASE ?? 'https://quote-api.jup.ag',
    jupiterPlatformFeeBps: Number(process.env.JUPITER_PLATFORM_FEE_BPS ?? 0),
    // Universe
    tokensUniverse: (process.env.TOKENS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    seedInBase: BigInt(process.env.SEED_IN_BASE ?? '1000000'),
    sizeLadder: parseBigints(process.env.SIZE_LADDER ?? '1000000,2000000,5000000'),
    // Risk / fees
    maxSlippageBps: Number(process.env.MAX_SLIPPAGE_BPS ?? 30),
    minAbsProfitUsd: Number(process.env.MIN_ABS_PROFIT_USD ?? 1.5),
    cooldownMs: Number(process.env.COOLDOWN_MS ?? 150),
    priorityFeeMin: Number(process.env.PRIORITY_FEE_MIN ?? 3000),
    priorityFeeMax: Number(process.env.PRIORITY_FEE_MAX ?? 30000),
    includeRatioTarget: Number(process.env.INCLUDE_RATIO_TARGET ?? 0.7),
    feeAdjStep: Number(process.env.FEE_ADJ_STEP ?? 1000),
    maxConsecutiveFails: Number(process.env.MAX_CONSECUTIVE_FAILS ?? 20),
    haltOnNegativeSim: (process.env.HALT_ON_NEGATIVE_SIM ?? 'false') === 'true',
    metricsPort: Number(process.env.METRICS_PORT ?? 9102),
};
//# sourceMappingURL=config.js.map