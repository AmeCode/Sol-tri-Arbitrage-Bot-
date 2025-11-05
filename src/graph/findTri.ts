import { PoolEdge } from './types.js';
import { canonicalMint, seedForMint } from '../util/mints.js';
import type { makeSizeLadder } from '../amounts.js';

type Ladder = ReturnType<typeof makeSizeLadder>;
type LadderLookup = (edge: PoolEdge) => Ladder | undefined;

export async function findTriCandidates(edges: PoolEdge[], ladderForEdge: LadderLookup): Promise<PoolEdge[][]> {
  type CanonEdge = { edge: PoolEdge; from: string; to: string };
  const canonEdges: CanonEdge[] = edges.map(edge => ({
    edge,
    from: canonicalMint(edge.from),
    to: canonicalMint(edge.to),
  }));

  const tokens = new Set<string>();
  for (const ce of canonEdges) {
    tokens.add(ce.from);
    tokens.add(ce.to);
  }

  const dropCounts: Record<string, number> = {};
  const logLimit: Record<string, number> = {};

  function note(reason: string, detail: () => string) {
    dropCounts[reason] = (dropCounts[reason] ?? 0) + 1;
    const seen = (logLimit[reason] ?? 0) + 1;
    logLimit[reason] = seen;
    if (seen <= 5) {
      console.log(`[scan] drop ${reason}: ${detail()}`);
    }
  }

  const out: PoolEdge[][] = [];
  let rawTriangles = 0;

  for (const a of canonEdges) for (const b of canonEdges) {
    if (a.edge === b.edge) {
      note('same_edge_ab', () => `${a.edge.id}`);
      continue;
    }
    if (a.to !== b.from) {
      note('mismatch_ab', () => `${a.edge.id} (${a.to}) -> ${b.edge.id} (${b.from})`);
      continue;
    }
    for (const c of canonEdges) {
      if (a.edge === c.edge || b.edge === c.edge) {
        note('same_edge_ca', () => `${a.edge.id}|${b.edge.id}|${c.edge.id}`);
        continue;
      }
      if (b.to !== c.from) {
        note('mismatch_bc', () => `${b.edge.id} (${b.to}) -> ${c.edge.id} (${c.from})`);
        continue;
      }
      if (c.to !== a.from) {
        note('mismatch_ca', () => `${c.edge.id} (${c.to}) -> ${a.edge.id} (${a.from})`);
        continue;
      }

      rawTriangles++;

      const ladder = ladderForEdge(a.edge);
      const startSeed = ladder?.[0] ? BigInt(ladder[0].toString()) : seedForMint(a.from);

      let q1: bigint;
      try {
        q1 = await a.edge.quoteOut(startSeed);
      } catch (e) {
        note('quote1_error', () => `${a.edge.id}: ${(e as Error)?.message ?? e}`);
        continue;
      }
      if (q1 <= 0n) {
        note('quote1_non_positive', () => `${a.edge.id} -> ${q1}`);
        continue;
      }

      let q2: bigint;
      try {
        q2 = await b.edge.quoteOut(q1);
      } catch (e) {
        note('quote2_error', () => `${b.edge.id}: ${(e as Error)?.message ?? e}`);
        continue;
      }
      if (q2 <= 0n) {
        note('quote2_non_positive', () => `${b.edge.id} -> ${q2}`);
        continue;
      }

      let q3: bigint;
      try {
        q3 = await c.edge.quoteOut(q2);
      } catch (e) {
        note('quote3_error', () => `${c.edge.id}: ${(e as Error)?.message ?? e}`);
        continue;
      }
      if (q3 <= 0n) {
        note('quote3_non_positive', () => `${c.edge.id} -> ${q3}`);
        continue;
      }

      if (q3 <= startSeed) {
        note('non_profitable', () => `${a.edge.id}|${b.edge.id}|${c.edge.id} -> ${q3} <= ${startSeed}`);
        continue;
      }

      out.push([a.edge, b.edge, c.edge]);
    }
  }

  console.log(`[scan] tokens=${tokens.size}, raw_triangles=${rawTriangles}, profitable=${out.length}`);
  console.log('[scan] drop summary=', dropCounts);

  if (rawTriangles === 0) {
    console.log('[scan] sample edges=', edges.slice(0, 10).map(e => `${e.from}->${e.to}`));
  }

  return out;
}

