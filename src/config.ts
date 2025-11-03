import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

export const CFG = {
  rpcRead: req('RPC_URL_READ'),
  rpcSend: req('RPC_URL_SEND'),
  rpcWs: req('RPC_URL_WS'),
  walletSecret: req('WALLET_SECRET'),
  jitoUrl: req('BLOCK_ENGINE_URL'),
  metricsPort: Number(process.env.METRICS_PORT ?? 9102),

  tokensUniverse: (process.env.TOKENS ?? '').split(',').filter(Boolean),

  priorityFeeMin: Number(process.env.PRIORITY_FEE_MIN ?? 5000),
  priorityFeeMax: Number(process.env.PRIORITY_FEE_MAX ?? 40000),
  feeAdjStep: Number(process.env.FEE_ADJ_STEP ?? 1000),
  includeRatioTarget: Number(process.env.INCLUDE_RATIO_TARGET ?? 0.3),

  cooldownMs: Number(process.env.COOLDOWN_MS ?? 350),
  maxConsecutiveFails: Number(process.env.MAX_CONSECUTIVE_FAILS ?? 5),
  haltOnNegativeSim: String(process.env.HALT_ON_NEGATIVE_SIM ?? 'false') === 'true',

  sizeLadder: (process.env.SIZE_LADDER ?? '1000000,2000000,5000000')
    .split(',').map(s => BigInt(s.trim())),

  // Pools
  pools: {
    orca: {
      solUsdc: process.env.ORCA_SOL_USDC_POOL ?? '',
      msolSol: process.env.ORCA_MSOL_SOL_POOL ?? '',
      solUsdt: process.env.ORCA_SOL_USDT_POOL ?? ''
    },
    ray: {
      solUsdc: process.env.RAY_CLMM_SOL_USDC ?? '',
      bonkUsdc: process.env.RAY_CLMM_BONK_USDC ?? '',
      jupUsdc: process.env.RAY_CLMM_JUP_USDC ?? ''
    },
    meteora: {
      solUsdc: process.env.METEORA_DLMM_SOL_USDC ?? '',
      bonkUsdc: process.env.METEORA_DLMM_BONK_USDC ?? '',
      jupUsdc: process.env.METEORA_DLMM_JUP_USDC ?? ''
    }
  },

  maxSlippageBps: 20,
};

