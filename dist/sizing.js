export async function bestSize(path, ladder) {
    let best = null;
    for (const s of ladder) {
        const o1 = await path[0].quoteOut(s);
        if (o1 <= 0n)
            continue;
        const o2 = await path[1].quoteOut(o1);
        if (o2 <= 0n)
            continue;
        const o3 = await path[2].quoteOut(o2);
        if (o3 <= s)
            continue;
        if (!best || (o3 - s) > (best.outAmount - best.inAmount))
            best = { inAmount: s, outAmount: o3 };
    }
    return best;
}
//# sourceMappingURL=sizing.js.map