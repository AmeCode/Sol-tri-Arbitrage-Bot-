// src/risk.ts (placeholder for USD oracles — optional)
import { CFG } from './config.js';
export function minOutWithSlippage(expOut) {
    const num = BigInt(10_000 - CFG.maxSlippageBps);
    return (expOut * num) / 10000n;
}
// TODO: Plug Pyth/Switchboard to gate by USD profit precisely.
// For now you can keep MIN_ABS_PROFIT_USD low or 0 and rely on positive o3 > s.
export function toUsd(_mint, _amountBaseUnits) {
    return 0;
}
//# sourceMappingURL=risk.js.map