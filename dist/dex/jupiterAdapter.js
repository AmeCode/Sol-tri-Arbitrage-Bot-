// src/dex/jupiterAdapter.ts (fresh quotes + swap ixs via Jupiter)
import { TransactionInstruction } from '@solana/web3.js';
import { CFG } from '../config.js';
import { request } from 'undici';
async function jupGet(path) {
    const url = `${CFG.jupiterBase}${path}`;
    const res = await request(url, { method: 'GET' });
    if (res.statusCode !== 200)
        throw new Error(`Jupiter GET ${path} ${res.statusCode}`);
    return res.body.json();
}
function ixFromBase64(b64) {
    const buf = Buffer.from(b64, 'base64');
    // @ts-ignore: deserialize is available in web3.js
    return TransactionInstruction.deserialize(buf);
}
export function jupEdge(fromMint, toMint) {
    const id = `jup:${fromMint}->${toMint}`;
    return {
        id,
        from: fromMint,
        to: toMint,
        feeBps: 0,
        async quoteOut(amountIn) {
            const q = await jupGet(`/v6/quote?inputMint=${fromMint}&outputMint=${toMint}` +
                `&amount=${amountIn.toString()}&slippageBps=${CFG.maxSlippageBps}` +
                `&platformFeeBps=${CFG.jupiterPlatformFeeBps}`);
            if (!q || !q.data || !q.data[0])
                return 0n;
            return BigInt(q.data[0].outAmount ?? '0');
        },
        async buildSwapIx(amountIn, _minOut, user) {
            // We rely on Jupiter's route building; we already enforced slippage in quote.
            const q = await jupGet(`/v6/quote?inputMint=${fromMint}&outputMint=${toMint}` +
                `&amount=${amountIn.toString()}&slippageBps=${CFG.maxSlippageBps}` +
                `&platformFeeBps=${CFG.jupiterPlatformFeeBps}`);
            if (!q || !q.data || !q.data[0])
                throw new Error('no route');
            const res = await request(`${CFG.jupiterBase}/v6/swap-instructions`, {
                method: 'POST',
                body: JSON.stringify({
                    route: q.data[0],
                    userPublicKey: user.toBase58(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    asLegacyTransaction: false
                }),
                headers: { 'content-type': 'application/json' }
            });
            if (res.statusCode !== 200)
                throw new Error(`Jupiter build ix ${res.statusCode}`);
            const payload = await res.body.json();
            const ixs = [];
            for (const si of (payload.setupInstructions || []))
                ixs.push(ixFromBase64(si));
            ixs.push(ixFromBase64(payload.swapInstruction));
            if (payload.cleanupInstruction)
                ixs.push(ixFromBase64(payload.cleanupInstruction));
            return ixs;
        }
    };
}
export function getEdgesFromJupiter(mints) {
    const edges = [];
    for (const a of mints)
        for (const b of mints) {
            if (a === b)
                continue;
            edges.push(jupEdge(a, b));
        }
    return edges;
}
//# sourceMappingURL=jupiterAdapter.js.map