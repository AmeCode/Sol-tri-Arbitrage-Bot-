import { PoolEdge } from './graph/types.js';
import type { makeSizeLadder } from './amounts.js';

type Ladder = ReturnType<typeof makeSizeLadder>;
type LadderLookup = (edge: PoolEdge) => Ladder | undefined;

export async function bestSize(path: PoolEdge[], ladderForEdge: LadderLookup) {
  const ladder = ladderForEdge(path[0]);
  if (!ladder || ladder.length === 0) return null;

  // conservative: pick the biggest size that still shows profit at quote time
  for (let i = ladder.length - 1; i >= 0; i--) {
    const amt = BigInt(ladder[i].toString());
    const q1 = await path[0].quoteOut(amt);
    if (q1 <= 0n) continue;
    const q2 = await path[1].quoteOut(q1);
    if (q2 <= 0n) continue;
    const q3 = await path[2].quoteOut(q2);
    if (q3 > amt) return { inAmount: amt, outAmount: q3 };
  }
  return null;
}

