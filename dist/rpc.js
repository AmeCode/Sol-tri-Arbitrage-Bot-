import { Connection } from '@solana/web3.js';
import { CFG } from './config.js';
/**
 * READ RPC (Helius): high-RPS account/state reads, quotes, occasional simulateTransaction if you want.
 * SEND RPC (Jito): fresh blockhash + low-latency path; we also use the Jito SDK for simulateBundle/sendBundle.
 */
export function makeConnections() {
    const read = new Connection(CFG.rpcRead, { commitment: 'confirmed' });
    const send = new Connection(CFG.rpcSend, { commitment: 'confirmed' });
    return { read, send };
}
/** Always fetch recent blockhash from the SEND RPC to align with the path you're submitting on. */
export async function getFreshBlockhash(sendConn) {
    const { blockhash } = await sendConn.getLatestBlockhash();
    return blockhash;
}
//# sourceMappingURL=rpc.js.map