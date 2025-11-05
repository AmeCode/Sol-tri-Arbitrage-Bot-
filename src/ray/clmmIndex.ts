import fetch from 'node-fetch';

export type RayClmmApiPool = {
  id?: string;            // or pool_id
  pool_id?: string;
  mintA?: string;         // or mint_a
  mintB?: string;         // or mint_b
  mint_a?: string;
  mint_b?: string;

  // Common useful fields (all optional – API variants differ)
  status?: string;        // e.g. "Trading", "Locked", "Ended", etc.
  state?: string;         // some endpoints use "state"
  liquidity?: number | string;
  tvl?: number | string;
  tvlUsd?: number | string;
  tvl_usd?: number | string;
  openTime?: number | string;
  isOpen?: boolean;
};

function normId(p: RayClmmApiPool): string | undefined {
  return (p.id || p.pool_id)?.toString();
}
export function normMintA(p: RayClmmApiPool): string | undefined {
  return (p.mintA || p.mint_a)?.toString();
}
export function normMintB(p: RayClmmApiPool): string | undefined {
  return (p.mintB || p.mint_b)?.toString();
}

function n(x: unknown): number {
  if (x == null) return 0;
  const v = Number(x);
  return Number.isFinite(v) ? v : 0;
}

export function isTradable(p?: RayClmmApiPool, minTvlUsd = 10): boolean {
  if (!p) return false;

  const status = (p.status || p.state || '').toLowerCase();
  if (status.includes('lock') || status.includes('stop') || status.includes('end') || status.includes('closed')) {
    return false;
  }
  // Some pools are "Trading" but have zero liquidity/TVL (effectively unrouteable)
  const liq = n(p.liquidity);
  const tvl = Math.max(n(p.tvl), n(p.tvlUsd), n(p.tvl_usd));
  if (liq <= 0 && tvl < minTvlUsd) return false;

  // If there is an explicit isOpen flag, respect it
  if (p.isOpen === false) return false;

  return true;
}

export class RayClmmIndex {
  private byId = new Map<string, RayClmmApiPool>();
  private byPair = new Map<string, string>(); // key: sorted m1|m2
  private loaded = false;

  constructor(
    private listUrl: string,
    private searchByMintsUrl?: string,
    private searchByIdUrl?: string
  ) {}

  private indexPool(p: RayClmmApiPool) {
    const id = normId(p);
    if (!id) return;
    this.byId.set(id, p);

    const a = normMintA(p);
    const b = normMintB(p);
    if (a && b) {
      const [m1, m2] = [a, b].sort();
      this.byPair.set(`${m1}|${m2}`, id);
    }
  }

  async loadOnce(): Promise<void> {
    if (this.loaded) return;
    const res = await fetch(this.listUrl);
    if (!res.ok) throw new Error(`[ray] fetch failed ${res.status} ${res.statusText}`);
    const json = await res.json();
    const list: RayClmmApiPool[] = Array.isArray(json)
      ? json
      : ((json as any).data ?? (json as any).pools ?? []);
    let added = 0;
    for (const raw of list) {
      const before = this.byId.size;
      this.indexPool(raw);
      if (this.byId.size > before) added++;
    }
    this.loaded = true;
    console.log(`[ray-index] loaded ${added} CLMM pools from API`);
  }

  getById(id: string): RayClmmApiPool | undefined {
    return this.byId.get(id);
  }

  findByMints(m1: string, m2: string): string | undefined {
    const [a, b] = [m1, m2].sort();
    return this.byPair.get(`${a}|${b}`);
  }

  async fetchByIdAndCache(id: string): Promise<RayClmmApiPool | undefined> {
    if (!this.searchByIdUrl) return undefined;
    const url = this.searchByIdUrl.replace('{id}', encodeURIComponent(id));
    const r = await fetch(url);
    if (!r.ok) return undefined;
    const j = await r.json();
    const arr: RayClmmApiPool[] = Array.isArray(j)
      ? j
      : ((j as any).data ?? (j as any).pools ?? []);
    if (!arr.length) return undefined;
    this.indexPool(arr[0]);
    return arr[0];
  }

  async fetchByMintsAndCache(m1: string, m2: string): Promise<RayClmmApiPool | undefined> {
    if (!this.searchByMintsUrl) return undefined;
    const url = this.searchByMintsUrl
      .replace('{m1}', encodeURIComponent(m1))
      .replace('{m2}', encodeURIComponent(m2));
    const r = await fetch(url);
    if (!r.ok) return undefined;
    const j = await r.json();
    const arr: RayClmmApiPool[] = Array.isArray(j)
      ? j
      : ((j as any).data ?? (j as any).pools ?? []);
    if (!arr.length) return undefined;
    // Prefer the first matching result
    this.indexPool(arr[0]);
    return arr[0];
  }

  debugInfo(id: string): string {
    const p = this.byId.get(id);
    if (!p) return `[ray-index] miss for ${id}`;
    const a = normMintA(p) ?? '?';
    const b = normMintB(p) ?? '?';
    const status = p.status || p.state || 'n/a';
    const liq = p.liquidity ?? 'n/a';
    const tvl = p.tvlUsd ?? p.tvl_usd ?? p.tvl ?? 'n/a';
    return `[ray-index] hit ${id} ${a}-${b} status=${status} liq=${liq} tvl=${tvl}`;
  }
}
