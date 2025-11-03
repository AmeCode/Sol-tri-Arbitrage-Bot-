export async function bestSize(path, ladder) {
    // conservative: pick the biggest size that still shows profit at quote time
    for (let i = ladder.length - 1; i >= 0; i--) {
        const amt = ladder[i];
        const q1 = await path[0].quoteOut(amt);
        if (q1 <= 0n)
            continue;
        const q2 = await path[1].quoteOut(q1);
        if (q2 <= 0n)
            continue;
        const q3 = await path[2].quoteOut(q2);
        if (q3 > amt)
            return { inAmount: amt, outAmount: q3 };
    }
    return null;
}
//# sourceMappingURL=sizing.js.map