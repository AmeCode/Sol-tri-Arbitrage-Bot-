import { RayClmmIndex } from './ray/clmmIndex.js';

const defaultApi = 'https://api.raydium.io/v2/ammV3/ammPools';
const apiUrl = process.env.RAY_CLMM_API ?? defaultApi;

if (!apiUrl) {
  throw new Error('RAY_CLMM_API missing and no default provided');
}

export const rayIndex = new RayClmmIndex(apiUrl);

export async function loadRayIndexOnce(): Promise<void> {
  await rayIndex.loadOnce();
}
