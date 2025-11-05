import fetch from 'node-fetch';

export type RayClmmApiPool = {
  id?: string;
  pool_id?: string;
  mintA?: string;
  mintB?: string;
  mint_a?: string;
  mint_b?: string;
  tickSpacing?: number;
  tick_spacing?: number;
};

export class RayClmmIndex {
  private byId = new Map<string, RayClmmApiPool>();
  private loaded = false;

  constructor(private apiUrl: string) {}

  async loadOnce(): Promise<void> {
    if (this.loaded) return;
    const url = this.apiUrl;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`[ray] fetch failed ${res.status} ${res.statusText}`);
    }
    const json = await res.json();
    const rawList = Array.isArray(json)
      ? json
      : (json as any).data ?? (json as any).pools ?? [];
    const list: RayClmmApiPool[] = Array.isArray(rawList) ? rawList : [];
    let added = 0;

    for (const raw of list) {
      const id = ((raw?.id ?? raw?.pool_id) ?? '').toString();
      if (!id) continue;

      const norm: RayClmmApiPool = {
        id,
        mintA: raw?.mintA ?? raw?.mint_a,
        mintB: raw?.mintB ?? raw?.mint_b,
        tickSpacing: (raw as any)?.tickSpacing ?? (raw as any)?.tick_spacing,
      };

      this.byId.set(id, norm);
      added++;
    }

    this.loaded = true;
    console.log(`[ray-index] loaded ${added} CLMM pools from API`);
  }

  getById(id: string): RayClmmApiPool | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  debugInfo(id: string): string {
    const hit = this.byId.get(id);
    if (!hit) return `[ray-index] miss for ${id}`;
    return `[ray-index] hit ${id} (${hit.mintA ?? '?'}-${hit.mintB ?? '?'})`;
  }
}
