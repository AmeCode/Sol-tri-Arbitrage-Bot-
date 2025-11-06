import fetch from 'node-fetch';
function normId(p) {
    return (p.id || p.pool_id)?.toString();
}
export function normMintA(p) {
    return (p.mintA || p.mint_a)?.toString();
}
export function normMintB(p) {
    return (p.mintB || p.mint_b)?.toString();
}
function n(x) {
    if (x == null)
        return 0;
    const v = Number(x);
    return Number.isFinite(v) ? v : 0;
}
export function isTradable(p, minTvlUsd = 10) {
    if (!p)
        return false;
    const status = (p.status || p.state || '').toLowerCase();
    if (status.includes('lock') || status.includes('stop') || status.includes('end') || status.includes('closed')) {
        return false;
    }
    // Some pools are "Trading" but have zero liquidity/TVL (effectively unrouteable)
    const liq = n(p.liquidity);
    const tvl = Math.max(n(p.tvl), n(p.tvlUsd), n(p.tvl_usd));
    if (liq <= 0 && tvl < minTvlUsd)
        return false;
    // If there is an explicit isOpen flag, respect it
    if (p.isOpen === false)
        return false;
    return true;
}
export class RayClmmIndex {
    listUrl;
    searchByMintsUrl;
    searchByIdUrl;
    byId = new Map();
    byPair = new Map(); // key: sorted m1|m2
    loaded = false;
    constructor(listUrl, searchByMintsUrl, searchByIdUrl) {
        this.listUrl = listUrl;
        this.searchByMintsUrl = searchByMintsUrl;
        this.searchByIdUrl = searchByIdUrl;
    }
    indexPool(p) {
        const id = normId(p);
        if (!id)
            return;
        this.byId.set(id, p);
        const a = normMintA(p);
        const b = normMintB(p);
        if (a && b) {
            const [m1, m2] = [a, b].sort();
            this.byPair.set(`${m1}|${m2}`, id);
        }
    }
    async loadOnce() {
        if (this.loaded)
            return;
        const res = await fetch(this.listUrl);
        if (!res.ok)
            throw new Error(`[ray] fetch failed ${res.status} ${res.statusText}`);
        const json = await res.json();
        const list = Array.isArray(json)
            ? json
            : (json.data ?? json.pools ?? []);
        let added = 0;
        for (const raw of list) {
            const before = this.byId.size;
            this.indexPool(raw);
            if (this.byId.size > before)
                added++;
        }
        this.loaded = true;
        console.log(`[ray-index] loaded ${added} CLMM pools from API`);
    }
    getById(id) {
        return this.byId.get(id);
    }
    findByMints(m1, m2) {
        const [a, b] = [m1, m2].sort();
        return this.byPair.get(`${a}|${b}`);
    }
    async fetchByIdAndCache(id) {
        if (!this.searchByIdUrl)
            return undefined;
        const url = this.searchByIdUrl.replace('{id}', encodeURIComponent(id));
        const r = await fetch(url);
        if (!r.ok)
            return undefined;
        const j = await r.json();
        const arr = Array.isArray(j)
            ? j
            : (j.data ?? j.pools ?? []);
        if (!arr.length)
            return undefined;
        this.indexPool(arr[0]);
        return arr[0];
    }
    async fetchByMintsAndCache(m1, m2) {
        if (!this.searchByMintsUrl)
            return undefined;
        const url = this.searchByMintsUrl
            .replace('{m1}', encodeURIComponent(m1))
            .replace('{m2}', encodeURIComponent(m2));
        const r = await fetch(url);
        if (!r.ok)
            return undefined;
        const j = await r.json();
        const arr = Array.isArray(j)
            ? j
            : (j.data ?? j.pools ?? []);
        if (!arr.length)
            return undefined;
        // Prefer the first matching result
        this.indexPool(arr[0]);
        return arr[0];
    }
    debugInfo(id) {
        const p = this.byId.get(id);
        if (!p)
            return `[ray-index] miss for ${id}`;
        const a = normMintA(p) ?? '?';
        const b = normMintB(p) ?? '?';
        const status = p.status || p.state || 'n/a';
        const liq = p.liquidity ?? 'n/a';
        const tvl = p.tvlUsd ?? p.tvl_usd ?? p.tvl ?? 'n/a';
        return `[ray-index] hit ${id} ${a}-${b} status=${status} liq=${liq} tvl=${tvl}`;
    }
}
//# sourceMappingURL=clmmIndex.js.map