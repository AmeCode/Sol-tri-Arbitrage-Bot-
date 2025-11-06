import fetch from 'node-fetch';
export class RayPoolRegistry {
    pageSize;
    ttlMs;
    map = new Map();
    lastRefresh = 0;
    constructor(pageSize = 500, ttlMs = 5 * 60 * 1000) {
        this.pageSize = pageSize;
        this.ttlMs = ttlMs;
    }
    upsertPools(pools) {
        for (const p of pools)
            this.map.set(p.id, p);
    }
    async refreshIfNeeded() {
        const now = Date.now();
        if (now - this.lastRefresh < this.ttlMs && this.map.size > 0)
            return;
        const pools = [];
        let page = 1;
        while (true) {
            const url = `https://api-v3.raydium.io/pools/info/list?poolType=concentrated&poolSortField=liquidity&sortType=desc&page=${page}&pageSize=${this.pageSize}`;
            const r = await fetch(url);
            if (!r.ok)
                throw new Error(`raydium list http ${r.status}`);
            const j = (await r.json());
            const list = j?.data?.data ?? j?.data ?? j?.list ?? [];
            if (!Array.isArray(list) || list.length === 0)
                break;
            for (const p of list) {
                if (!p?.id || !p?.mintA || !p?.mintB || !p?.programId)
                    continue;
                pools.push({
                    id: p.id,
                    programId: p.programId,
                    mintA: p.mintA,
                    mintB: p.mintB,
                    config: p.config,
                    price: p.price,
                });
            }
            if (list.length < this.pageSize)
                break;
            page += 1;
        }
        this.map.clear();
        this.upsertPools(pools);
        this.lastRefresh = now;
        console.log(`[ray] loaded ${this.map.size} CLMM pools from API`);
    }
    async getById(id) {
        await this.refreshIfNeeded();
        return this.map.get(id);
    }
    async loadByIds(ids) {
        if (ids.length === 0)
            return;
        const url = `https://api-v3.raydium.io/pools/info/ids?ids=${ids.join(',')}`;
        const r = await fetch(url);
        if (!r.ok)
            throw new Error(`raydium ids http ${r.status}`);
        const j = (await r.json());
        const list = j?.data ?? [];
        const pools = [];
        for (const p of list) {
            if (!p?.id || !p?.mintA || !p?.mintB || !p?.programId)
                continue;
            pools.push({
                id: p.id,
                programId: p.programId,
                mintA: p.mintA,
                mintB: p.mintB,
                config: p.config,
                price: p.price,
            });
        }
        this.upsertPools(pools);
        console.log(`[ray] loaded ${pools.length} pools by id`);
    }
}
//# sourceMappingURL=api.js.map