import { RayClmmIndex } from './ray/clmmIndex.js';
const defaultApi = 'https://api.raydium.io/v2/ammV3/ammPools';
const apiUrl = process.env.RAY_CLMM_API ?? defaultApi;
const searchByMints = process.env.RAY_CLMM_SEARCH_MINTS_API;
const searchById = process.env.RAY_CLMM_SEARCH_ID_API;
if (!apiUrl) {
    throw new Error('RAY_CLMM_API missing and no default provided');
}
export const rayIndex = new RayClmmIndex(apiUrl, searchByMints, searchById);
export async function loadRayIndexOnce() {
    await rayIndex.loadOnce();
}
//# sourceMappingURL=initRay.js.map