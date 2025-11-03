import { searcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
/** Create a Searcher client for Jito Block Engine (no auth key needed). */
export function makeJitoClient(blockEngineUrl, _auth) {
    if (!blockEngineUrl)
        throw new Error('BLOCK_ENGINE_URL missing');
    // Pass undefined for auth to use public access
    return searcherClient(blockEngineUrl, undefined);
}
//# sourceMappingURL=jito.js.map