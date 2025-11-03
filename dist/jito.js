import { JitoRpcClient } from 'jito-js-rpc';
export function jitoClient(url) {
    return new JitoRpcClient({ url });
}
export async function simulateBundle(jito, base64Txs) {
    return jito.simulateBundle({ transactions: base64Txs });
}
export async function sendBundle(jito, base64Txs) {
    return jito.sendBundle({ transactions: base64Txs });
}
//# sourceMappingURL=jito.js.map