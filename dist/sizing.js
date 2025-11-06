export async function bestSize(path, ladder) {
    // conservative: pick the biggest size that still shows profit at quote time
    for (let i = ladder.length - 1; i >= 0; i--) {
        const amt = ladder[i];
        let current = amt;
        let ok = true;
        for (const edge of path) {
            current = await edge.quoteOut(current);
            if (current <= 0n) {
                ok = false;
                break;
            }
        }
        if (ok && current > amt)
            return { inAmount: amt, outAmount: current };
    }
    return null;
}
//# sourceMappingURL=sizing.js.map