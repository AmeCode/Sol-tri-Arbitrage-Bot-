export async function findTriCandidates(edges, seed) {
    const byFrom = new Map();
    for (const e of edges) {
        if (!byFrom.has(e.from))
            byFrom.set(e.from, []);
        byFrom.get(e.from).push(e);
    }
    const res = [];
    for (const e1 of edges) {
        const o1 = await e1.quoteOut(seed);
        if (o1 <= 0n)
            continue;
        for (const e2 of (byFrom.get(e1.to) ?? [])) {
            const o2 = await e2.quoteOut(o1);
            if (o2 <= 0n)
                continue;
            for (const e3 of (byFrom.get(e2.to) ?? [])) {
                if (e3.to !== e1.from)
                    continue;
                const o3 = await e3.quoteOut(o2);
                if (o3 > seed)
                    res.push([e1, e2, e3]);
            }
        }
    }
    return res;
}
//# sourceMappingURL=findTri.js.map