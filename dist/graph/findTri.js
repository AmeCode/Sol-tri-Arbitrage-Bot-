export async function findTriCandidates(edges, seedInBase) {
    // trivial triple-nested candidate builder; you can cache adjacency if you want
    const out = [];
    for (const a of edges)
        for (const b of edges) {
            if (a.to !== b.from)
                continue;
            for (const c of edges) {
                if (b.to !== c.from)
                    continue;
                if (c.to !== a.from)
                    continue;
                // quick re-quote to gate out dead paths (fast path)
                const q1 = await a.quoteOut(seedInBase);
                if (q1 <= 0n)
                    continue;
                const q2 = await b.quoteOut(q1);
                if (q2 <= 0n)
                    continue;
                const q3 = await c.quoteOut(q2);
                if (q3 > seedInBase)
                    out.push([a, b, c]);
            }
        }
    return out;
}
//# sourceMappingURL=findTri.js.map