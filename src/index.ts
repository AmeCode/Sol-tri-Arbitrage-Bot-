import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import BN from 'bn.js';
type BNType = InstanceType<typeof BN>;

import { CFG } from './config.js';
import { IS_SIM, IS_LIVE, RUNTIME } from './runtime.js';
import { makeConnections } from './rpc.js';
import { buildEdges } from './graph/builder.js';
import { findTriCandidates } from './graph/findTri.js';
import { bestSize } from './sizing.js';
import {
  startMetrics,
  cBundlesOk,
  cBundlesSent,
  cExecFail,
  gIncludeRatio,
  gPriorityFee,
  cScansTotal,
} from './metrics.js';
import { loadStaticLuts } from './lut/lookupTables.js';
import type { PoolEdge } from './graph/types.js';
import type { DexEdge, Quote } from './dex/types.js';

function allowedByHopCount(pathLen: number) {
  if (pathLen <= CFG.maxHops) return true;
  const hasStaticLut = IS_LIVE && RUNTIME.lutAddresses.length > 0;
  if (pathLen === 3 && CFG.allowThirdHop && hasStaticLut) return true;
  return false;
}

type RouteEvaluation = {
  quotes: Quote[];
  finalAmount: BNType;
  totalFee: BNType;
  pnl: BNType;
};

async function evaluateRoute(
  path: PoolEdge[],
  amountIn: BNType,
  user: PublicKey,
): Promise<RouteEvaluation> {
  const quotes: Quote[] = [];
  let currentAmount = amountIn;
  let totalFee = new BN(0) as BNType;

  for (const hop of path) {
    const dexHop = hop as Partial<DexEdge>;
    let q: Quote;
    if (typeof dexHop.quote === 'function') {
      q = await dexHop.quote(currentAmount, user);
    } else {
      const legacyOut = await hop.quoteOut(BigInt(currentAmount.toString()));
      const amountOut = new BN(legacyOut.toString()) as BNType;
      const zeroFee = new BN(0) as BNType;
      q = { amountIn: currentAmount, amountOut, fee: zeroFee, minOut: amountOut };
    }
    quotes.push(q);
    currentAmount = q.amountOut;
    totalFee = totalFee.add(q.fee) as BNType;
  }

  const pnl = currentAmount.sub(amountIn).sub(totalFee) as BNType;
  return { quotes, finalAmount: currentAmount, totalFee, pnl };
}

type LiveBuild = {
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
};

async function buildLiveInstructions(
  path: PoolEdge[],
  amountIn: BNType,
  user: PublicKey,
): Promise<LiveBuild> {
  const instructions: TransactionInstruction[] = [];
  const lookupTables: AddressLookupTableAccount[] = [];
  const seen = new Set<string>();
  let currentAmount = amountIn;

  for (const hop of path) {
    const dexHop = hop as unknown as DexEdge;
    if (typeof dexHop.quote !== 'function' || typeof dexHop.buildSwapIx !== 'function') {
      throw new Error(`edge ${hop.id} missing DexEdge implementation`);
    }
    const quote = await dexHop.quote(currentAmount, user);
    const built = await dexHop.buildSwapIx(currentAmount, quote.minOut, user);
    if (built.ixs?.length) instructions.push(...built.ixs);
    if (built.lookupTables?.length) {
      for (const lut of built.lookupTables) {
        const key = lut.key.toBase58();
        if (seen.has(key)) continue;
        seen.add(key);
        lookupTables.push(lut);
      }
    }
    currentAmount = quote.amountOut;
  }

  return { instructions, lookupTables };
}

async function executeLiveRoute(
  connection: Connection,
  path: PoolEdge[],
  amountIn: BNType,
  wallet: Keypair,
  priorityFee: number,
): Promise<string> {
  const built = await buildLiveInstructions(path, amountIn, wallet.publicKey);
  if (built.instructions.length === 0) {
    throw new Error('route produced no instructions');
  }

  const staticLuts = await loadStaticLuts(connection);
  const lutAccounts = [...staticLuts, ...built.lookupTables];

  const withCompute: TransactionInstruction[] = [];
  const cuLimit = CFG.cuLimit ?? 1_400_000;
  if (cuLimit) {
    withCompute.push(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  }
  if (priorityFee > 0) {
    withCompute.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(
    'processed',
  );
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [...withCompute, ...built.instructions],
  }).compileToV0Message(lutAccounts);

  const tx = new VersionedTransaction(message);
  tx.sign([wallet]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  console.log('[send] success', signature);
  return signature;
}

async function main() {
  if (!CFG.walletSecret) throw new Error('WALLET_SECRET missing');

  startMetrics();

  const heartbeat = setInterval(() => {
    console.log(`[loop] heartbeat ${new Date().toISOString()}`);
  }, CFG.scanIntervalMs ?? 2000);
  heartbeat.unref?.();

  const { send: sendConn } = makeConnections();
  const wallet = Keypair.fromSecretKey(bs58.decode(CFG.walletSecret));

  const edges = await buildEdges();
  console.log(`[init] edges=${edges.length}, tokens=${CFG.tokensUniverse.length}`);

  let priorityFee = CFG.priorityFeeMin;
  let sent = 0;
  let ok = 0;
  let consecutiveFails = 0;

  function tuneFee() {
    const ratio = sent ? ok / sent : 0;
    gIncludeRatio.set(ratio);
    if (ratio < CFG.includeRatioTarget && priorityFee < CFG.priorityFeeMax) {
      priorityFee += CFG.feeAdjStep;
    }
    if (ratio > CFG.includeRatioTarget && priorityFee > CFG.priorityFeeMin) {
      priorityFee -= CFG.feeAdjStep;
    }
    if (priorityFee < CFG.priorityFeeMin) priorityFee = CFG.priorityFeeMin;
    if (priorityFee > CFG.priorityFeeMax) priorityFee = CFG.priorityFeeMax;
    gPriorityFee.set(priorityFee);
  }

  while (true) {
    try {
      console.log(`[loop] tick ${new Date().toISOString()}`);
      cScansTotal.inc();
      console.log('[scan] start');
      console.log(`[scan] edges=${edges.length}`);
      const seed = CFG.sizeLadder[0];
      console.log(`[scan] building candidates with seed=${seed}`);
      const candidates = await findTriCandidates(edges, seed);
      const filteredCandidates = candidates.filter((path) =>
        allowedByHopCount(path.length),
      );
      console.log(
        `[scan] candidates=${candidates.length}, filtered=${filteredCandidates.length}`,
      );

      for (const path of filteredCandidates) {
        const sized = await bestSize(path, CFG.sizeLadder);
        if (!sized) continue;

        const routeId = path.map((e) => e.id).join(' -> ');
        console.log(`[scan] evaluating route ${routeId}`);

        const amountInBn = new BN(sized.inAmount.toString()) as BNType;

        let evaluation: RouteEvaluation;
        try {
          evaluation = await evaluateRoute(path, amountInBn, wallet.publicKey);
        } catch (e) {
          console.warn('[quote] evaluation failed:', (e as Error)?.message ?? e);
          continue;
        }

        const pnlBps = amountInBn.gt(new BN(0))
          ? Number(evaluation.pnl.muln(10_000).div(amountInBn).toString())
          : 0;
        console.log(
          `[sim] route=${routeId} expectedOut=${evaluation.finalAmount.toString()} pnlBps=${pnlBps}`,
        );

        if (evaluation.pnl.lte(new BN(0))) {
          continue;
        }

        if (IS_SIM) {
          console.log('[sim] simulate mode → skipping live execution');
          tuneFee();
          continue;
        }

        try {
          const signature = await executeLiveRoute(
            sendConn,
            path,
            amountInBn,
            wallet,
            priorityFee,
          );
          console.log('[send] signature', signature);
          cBundlesSent.inc();
          sent++;
          cBundlesOk.inc();
          ok++;
          consecutiveFails = 0;
        } catch (e: any) {
          cBundlesSent.inc();
          sent++;
          cExecFail.inc();
          consecutiveFails++;
          console.error('[send] error', e?.message ?? e);
        }

        tuneFee();

        if (consecutiveFails >= CFG.maxConsecutiveFails) {
          console.error(`[risk] ${consecutiveFails} consecutive fails → cooldown`);
          await new Promise((r) => setTimeout(r, 5000));
          consecutiveFails = 0;
        }
      }

      await new Promise((r) => setTimeout(r, CFG.cooldownMs));
    } catch (e) {
      console.error('[loop]', e);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch(console.error);
