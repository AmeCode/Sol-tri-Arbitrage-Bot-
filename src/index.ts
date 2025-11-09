import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

import { CFG } from './config.js';
import { RUNTIME, withRuntimeMode } from './runtime.js';
import { makeConnections } from './rpc.js';
import { buildEdges } from './graph/builder.js';
import { findTriCandidates } from './graph/findTri.js';
import { bestSize } from './sizing.js';
import {
  startMetrics,
  cBundlesOk,
  cBundlesSent,
  cSimFail,
  cExecFail,
  gIncludeRatio,
  gPriorityFee,
  cScansTotal,
} from './metrics.js';
import { loadLookupTableAccounts, loadStaticLuts } from './lut/lookupTables.js';
import type { PoolEdge } from './graph/types.js';

function allowedByHopCount(pathLen: number) {
  if (pathLen <= CFG.maxHops) return true;
  const hasStaticLut = RUNTIME.useLut && RUNTIME.lutAddresses.length > 0;
  if (pathLen === 3 && CFG.allowThirdHop && hasStaticLut) return true;
  return false;
}

type RouteBuild = {
  instructions: TransactionInstruction[];
  extraSigners: Keypair[];
  lookupTables: PublicKey[];
};

async function buildRouteIxs(
  mode: 'simulate' | 'live',
  path: PoolEdge[],
  hopQuotes: bigint[],
  walletPk: PublicKey,
  amountIn: bigint,
): Promise<RouteBuild> {
  return withRuntimeMode(mode, async () => {
    const instructions: TransactionInstruction[] = [];
    const extraSigners: Keypair[] = [];
    const lookupTables: PublicKey[] = [];

    let currentAmount = amountIn;
    for (let i = 0; i < path.length; i++) {
      const edge = path[i];
      const minOut = hopQuotes[i];
      const result = await edge.buildSwapIx(currentAmount, minOut, walletPk);
      if (result.ixs?.length) instructions.push(...result.ixs);
      if (result.extraSigners?.length) extraSigners.push(...result.extraSigners);
      if (result.lookupTables?.length) {
        for (const lut of result.lookupTables) {
          if (!lookupTables.some((pk) => pk.equals(lut))) {
            lookupTables.push(lut);
          }
        }
      }
      currentAmount = minOut;
    }

    return { instructions, extraSigners, lookupTables };
  });
}

type TryRouteParams = {
  mode: 'simulate' | 'live';
  connection: Connection;
  path: PoolEdge[];
  hopQuotes: bigint[];
  wallet: Keypair;
  amountIn: bigint;
  priorityFee: number;
};

type TryRouteResult =
  | { kind: 'simulate'; sim: Awaited<ReturnType<Connection['simulateTransaction']>> }
  | { kind: 'live'; signature: string };

async function tryRoute({
  mode,
  connection,
  path,
  hopQuotes,
  wallet,
  amountIn,
  priorityFee,
}: TryRouteParams): Promise<TryRouteResult> {
  const built = await buildRouteIxs(mode, path, hopQuotes, wallet.publicKey, amountIn);
  if (built.instructions.length === 0) {
    throw new Error('route produced no instructions');
  }

  const staticLuts = await loadStaticLuts(connection);
  const seen = new Set(staticLuts.map((acc) => acc.key.toBase58()));
  const dynamicAddresses = built.lookupTables.filter((pk) => {
    const key = pk.toBase58();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dynamicLuts = await loadLookupTableAccounts(connection, dynamicAddresses);
  const lutAccounts = [...staticLuts, ...dynamicLuts];

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
  const signers = [wallet, ...built.extraSigners];
  tx.sign(signers);

  if (mode === 'simulate') {
    const sim = await connection.simulateTransaction(tx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    return { kind: 'simulate', sim };
  }

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  });
  await connection.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    'confirmed',
  );
  console.log('[send] success', signature);
  return { kind: 'live', signature };
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

        const hopQuotes: bigint[] = [];
        let currentAmount = sized.inAmount;
        let quotesOk = true;
        for (let i = 0; i < path.length; i++) {
          const edge = path[i];
          try {
            console.log(`[quote] via ${edge.id} amountIn=${currentAmount}`);
            const out = await edge.quoteOut(currentAmount);
            if (out <= 0n) {
              console.warn(`[quote] ${edge.id} returned ${out} for ${currentAmount}`);
              quotesOk = false;
              break;
            }
            hopQuotes.push(out);
            currentAmount = out;
          } catch (e) {
            console.warn(`[quote] ${edge.id} failed:`, (e as Error)?.message ?? e);
            quotesOk = false;
            break;
          }
        }
        if (!quotesOk || hopQuotes.length === 0) continue;

        const finalOut = hopQuotes[hopQuotes.length - 1];
        const pnl = finalOut - sized.inAmount;
        const pnlBps = sized.inAmount > 0n ? Number((pnl * 10_000n) / sized.inAmount) : 0;
        console.log(`[sim] route=${routeId} expectedOut=${finalOut} pnlBps=${pnlBps}`);

        if (finalOut <= sized.inAmount) continue;

        let skipTune = false;

        const simResult = await tryRoute({
          mode: 'simulate',
          connection: sendConn,
          path,
          hopQuotes,
          wallet,
          amountIn: sized.inAmount,
          priorityFee,
        });

        if (simResult.kind !== 'simulate') {
          console.warn('[sim] unexpected result kind');
          continue;
        }

        if (simResult.sim.value.err) {
          console.warn('[sim] failed:', simResult.sim.value.err);
          simResult.sim.value.logs?.forEach((l, i) =>
            console.warn(String(i).padStart(2, '0'), l),
          );
          cSimFail.inc();
          consecutiveFails++;
          if (CFG.haltOnNegativeSim) skipTune = true;
          if (!skipTune) {
            tuneFee();
            if (consecutiveFails >= CFG.maxConsecutiveFails) {
              console.error(`[risk] ${consecutiveFails} consecutive fails → cooldown`);
              await new Promise((r) => setTimeout(r, 5000));
              consecutiveFails = 0;
            }
          }
          continue;
        }

        if (RUNTIME.configuredMode === 'simulate') {
          console.log('[sim] MODE=simulate → not sending live tx');
          tuneFee();
          continue;
        }

        try {
          const sendResult = await tryRoute({
            mode: 'live',
            connection: sendConn,
            path,
            hopQuotes,
            wallet,
            amountIn: sized.inAmount,
            priorityFee,
          });

          if (sendResult.kind !== 'live') {
            throw new Error('expected live result');
          }

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
