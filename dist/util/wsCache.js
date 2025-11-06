export class WsAccountCache {
    conn;
    m = new Map();
    constructor(conn) {
        this.conn = conn;
    }
    /** Subscribe and keep latest data in memory */
    subscribe(pk, onChange) {
        const key = pk.toBase58();
        return this.conn.onAccountChange(pk, (acc, ctx) => {
            this.m.set(key, { slot: ctx.slot, data: acc.data });
            onChange?.(ctx.slot);
        }, 'processed');
    }
    get(pk) {
        return this.m.get(pk.toBase58());
    }
    /** If not present in cache, fetch once */
    async getOrFetch(pk) {
        const k = pk.toBase58();
        const cur = this.m.get(k);
        if (cur)
            return cur;
        const acc = await this.conn.getAccountInfo(pk, 'processed');
        if (!acc)
            return undefined;
        const slot = await this.conn.getSlot('processed');
        const e = { slot, data: acc.data };
        this.m.set(k, e);
        return e;
    }
}
//# sourceMappingURL=wsCache.js.map