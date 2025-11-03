import { getEdgesFromJupiter } from '../dex/jupiterAdapter.js';
import { CFG } from '../config.js';
export async function buildEdges() {
    if (CFG.tokensUniverse.length < 3) {
        throw new Error('TOKENS must include at least 3 mint addresses for triangular arb.');
    }
    return getEdgesFromJupiter(CFG.tokensUniverse);
}
//# sourceMappingURL=builder.js.map