import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing`);
  return v;
}

export type PoolDef = {
  /** full env var name */
  key: string;
  /** on-chain pool address */
  id: string;
  /** token symbols from the env var name (uppercased) */
  a: string;
  b: string;
};

/** Load pools whose env var names match: PREFIX_A_B or PREFIX_A_B_POOL */
function loadPools(prefix: string): PoolDef[] {
  // Example matches:
  //  - ORCA_SOL_USDC_POOL
  //  - RAY_CLMM_MSOL_USDC
  //  - METEORA_DLMM_BONK_SOL
  const rx = new RegExp(`^${prefix}([A-Z0-9]+)_([A-Z0-9]+)(?:_POOL)?$`);
  const out: PoolDef[] = [];

  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue;
    const m = key.match(rx);
    if (!m) continue;
    const [, a, b] = m;
    out.push({ key, id: val, a, b });
  }
  return out;
}

export const CFG = {
  rpcRead: req('RPC_URL_READ'),
  rpcSend: req('RPC_URL_SEND'),
  rpcWs: req('RPC_URL_WS'),
  walletSecret: req('WALLET_SECRET'),
  jitoUrl: req('BLOCK_ENGINE_URL'),
  metricsPort: Number(process.env.METRICS_PORT ?? 9102),
  raydiumApiBase: process.env.RAYDIUM_API_BASE ?? 'https://api-v3.raydium.io',


  tokensUniverse: (process.env.TOKENS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),

  priorityFeeMin: Number(process.env.PRIORITY_FEE_MIN ?? 5000),
  priorityFeeMax: Number(process.env.PRIORITY_FEE_MAX ?? 40000),
  feeAdjStep: Number(process.env.FEE_ADJ_STEP ?? 1000),
  includeRatioTarget: Number(process.env.INCLUDE_RATIO_TARGET ?? 0.3),

  scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? 2000),
  cooldownMs: Number(process.env.COOLDOWN_MS ?? 350),
  maxConsecutiveFails: Number(process.env.MAX_CONSECUTIVE_FAILS ?? 5),
  haltOnNegativeSim: String(process.env.HALT_ON_NEGATIVE_SIM ?? 'false') === 'true',

  sizeLadder: (process.env.SIZE_LADDER ?? '1000000,2000000,5000000')
    .split(',')
    .map(s => BigInt(s.trim())),

  // Dynamically discovered pools from .env
  pools: {
    orca: loadPools('ORCA_'),
    ray: loadPools('RAY_CLMM_'),
    meteora: loadPools('METEORA_DLMM_'),
  },

  maxSlippageBps: 20,
  maxHops: Number(process.env.MAX_HOPS ?? 2),
  allowThirdHop: String(process.env.ALLOW_THIRD_HOP ?? 'true') === 'true',
  lutAddressEnv: process.env.LUT_ADDRESS ?? '',
  debugSim: String(process.env.DEBUG_SIM ?? 'true') === 'true',
  cuLimit: Number(process.env.CU_LIMIT ?? 1_000_000),
  cuPriceMicroLamports: Number(process.env.CU_PRICE_MICROLAMPORTS ?? 0),
};

// Optional: one-time sanity logs
if (process.env.CONFIG_DEBUG === '1') {
  console.log('[cfg] orca', CFG.pools.orca);
  console.log('[cfg] ray', CFG.pools.ray);
  console.log('[cfg] meteora', CFG.pools.meteora);
  console.log('[cfg] tokens', CFG.tokensUniverse);
}
