import { Connection } from '@solana/web3.js';
import { CFG } from './config.js';
export function makeConnections() {
    const read = new Connection(CFG.rpcRead, { commitment: 'processed', wsEndpoint: CFG.rpcWs });
    const send = new Connection(CFG.rpcSend, { commitment: 'processed', wsEndpoint: CFG.rpcWs });
    return { read, send };
}
export async function getFreshBlockhash(conn) {
    // “processed” → fresher blockhash for bundles
    return conn.getLatestBlockhash('processed');
}
//# sourceMappingURL=rpc.js.map