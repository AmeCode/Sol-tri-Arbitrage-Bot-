import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';

type Entry = { slot: number; data: Buffer };
export class WsAccountCache {
  private m = new Map<string, Entry>();

  constructor(private conn: Connection) {}

  /** Subscribe and keep latest data in memory */
  subscribe(pk: PublicKey, onChange?: (slot: number) => void): number {
    const key = pk.toBase58();
    return this.conn.onAccountChange(pk, (acc: AccountInfo<Buffer>, ctx) => {
      this.m.set(key, { slot: ctx.slot, data: acc.data });
      onChange?.(ctx.slot);
    }, 'processed');
  }

  get(pk: PublicKey): Entry | undefined {
    return this.m.get(pk.toBase58());
  }

  /** If not present in cache, fetch once */
  async getOrFetch(pk: PublicKey): Promise<Entry | undefined> {
    const k = pk.toBase58();
    const cur = this.m.get(k);
    if (cur) return cur;
    const acc = await this.conn.getAccountInfo(pk, 'processed');
    if (!acc) return undefined;
    const slot = await this.conn.getSlot('processed');
    const e = { slot, data: acc.data };
    this.m.set(k, e);
    return e;
    }
}

