import { CFG } from './config.js';
import { makeConnections } from './rpc.js';
import { buildEdges } from './graph/builder.js';
import { findTriCandidates } from './graph/findTri.js';
import { bestSize } from './sizing.js';
import { startMetrics, cBundlesOk, cBundlesSent, cSimFail, cExecFail, gIncludeRatio, gPriorityFee, cScansTotal } from './metrics.js';
import { Keypair, PublicKey, Connection, TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';
import { ensureLutHas } from './lut.js';
import { buildAndMaybeLut, getRuntimeLutAddress, setRuntimeLutAddress } from './tx.js';
import { sendAndConfirmAny, simulateWithLogs } from './send.js';

function allowedByHopCount(pathLen: number, lutExists: boolean) {
  if (pathLen <= CFG.maxHops) return true;
  if (pathLen === 3 && CFG.allowThirdHop && lutExists) return true;
  return false;
}

function isInvalidLookupTableError(err: unknown, logs?: string[] | null): boolean {
  try {
    const errString = typeof err === 'string' ? err : JSON.stringify(err);
    if (errString && errString.toLowerCase().includes('invalid index')) return true;
  } catch {
    /* ignore */
  }
  if (Array.isArray(logs)) {
    for (const line of logs) {
      if (typeof line === 'string' && line.toLowerCase().includes('invalid index')) {
        return true;
      }
    }
  }
  return false;
}

async function primeLutFromRegistry(connection: Connection, wallet: Keypair) {
  const pools = [...CFG.pools.orca, ...CFG.pools.ray, ...CFG.pools.meteora];
  const seen = new Set<string>();
  const keys: PublicKey[] = [];
  for (const pool of pools) {
    try {
      const pk = new PublicKey(pool.id);
      const base58 = pk.toBase58();
      if (!seen.has(base58)) {
        seen.add(base58);
        keys.push(pk);
      }
    } catch (e) {
      console.warn('[lut] skip invalid pool id', pool.id, (e as Error)?.message ?? e);
    }
  }
  if (keys.length === 0) return;
  try {
    const ensured = await ensureLutHas(connection, wallet.publicKey, wallet, getRuntimeLutAddress(), keys);
    setRuntimeLutAddress(ensured);
    console.log('[lut] primed from registry', ensured.toBase58(), 'keys', keys.length);
  } catch (e) {
    console.error('[lut] prime failed', (e as Error)?.message ?? e);
  }
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

  // Build edges and set up WS subs inside builder
  const edges = await buildEdges();
  console.log(`[init] edges=${edges.length}, tokens=${CFG.tokensUniverse.length}`);

  await primeLutFromRegistry(sendConn, wallet);

  let priorityFee = CFG.priorityFeeMin;
  let sent = 0, ok = 0, consecutiveFails = 0;

  function tuneFee() {
    const ratio = sent ? ok / sent : 0;
    gIncludeRatio.set(ratio);
    if (ratio < CFG.includeRatioTarget && priorityFee < CFG.priorityFeeMax) priorityFee += CFG.feeAdjStep;
    if (ratio > CFG.includeRatioTarget && priorityFee > CFG.priorityFeeMin) priorityFee -= CFG.feeAdjStep;
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
      const seed = CFG.sizeLadder[0]; // seed for candidate scan
      console.log(`[scan] building candidates with seed=${seed}`);
      const candidates = await findTriCandidates(edges, seed);
      const lutExists = getRuntimeLutAddress() !== null;
      const filteredCandidates = candidates.filter(path => allowedByHopCount(path.length, lutExists));
      console.log(`[scan] candidates=${candidates.length}, filtered=${filteredCandidates.length}`);

      for (const path of filteredCandidates) {
        const sized = await bestSize(path, CFG.sizeLadder);
        if (!sized) continue;

        const routeId = path.map(e => e.id).join(' -> ');
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

        console.log('[send] building tx...');
        const swapIxs: TransactionInstruction[] = [];
        const extraSigners: Keypair[] = [];
        const dexLookupTables: PublicKey[] = [];
        const dexLookupSet = new Set<string>();
        let amountIn = sized.inAmount;
        for (let i = 0; i < path.length; i++) {
          const edge = path[i];
          const minOut = hopQuotes[i];
          const result = await edge.buildSwapIx(amountIn, minOut, wallet.publicKey);
          swapIxs.push(...result.ixs);
          if (result.extraSigners?.length) {
            extraSigners.push(...result.extraSigners);
          }
          if (result.lookupTableAddresses?.length) {
            for (const lut of result.lookupTableAddresses) {
              try {
                const pk = typeof lut === 'string' ? new PublicKey(lut) : lut;
                const key = pk.toBase58();
                if (!dexLookupSet.has(key)) {
                  dexLookupSet.add(key);
                  dexLookupTables.push(pk);
                }
              } catch (e) {
                console.warn('[lut] skip invalid address', lut, (e as Error)?.message ?? e);
              }
            }
          }
          amountIn = minOut;
        }

        if (swapIxs.length === 0) {
          console.warn('[route] no instructions built, skipping');
          continue;
        }

        let skipPostProcessing = false;
        let skipTune = false;
        try {
          // 👉 Build (legacy first, then v0/LUT if needed)
          let built = await buildAndMaybeLut(
            sendConn,
            wallet.publicKey,
            wallet,
            swapIxs,
            /* cuPrice */ priorityFee,      // micro-lamports per CU
            /* cuLimit  */ CFG.cuLimit ?? 1_400_000,
            /* extraSignerPubkeys */ extraSigners.map(k => k.publicKey),
            /* dexLookupTables */ dexLookupTables,
            /* includeRuntimeLut */ true,
          );

          console.log('[route] instructions count =', swapIxs.length);
          if ('lutAddressUsed' in built && built.lutAddressUsed) {
            console.log('[lut] used', built.lutAddressUsed.toBase58());
          }
          if (dexLookupTables.length) {
            console.log('[lut] dex tables', dexLookupTables.map(l => l.toBase58()));
          }

          // 👉 Simulate (always signed; gets logs)
          let sim = await simulateWithLogs(sendConn, built, [wallet, ...extraSigners]);
          if (
            sim.value.err &&
            built.kind === 'v0' &&
            dexLookupTables.length > 0 &&
            isInvalidLookupTableError(sim.value.err, sim.value.logs)
          ) {
            console.warn('[sim] invalid LUT index detected → rebuilding without runtime LUT');
            built = await buildAndMaybeLut(
              sendConn,
              wallet.publicKey,
              wallet,
              swapIxs,
              /* cuPrice */ priorityFee,
              /* cuLimit  */ CFG.cuLimit ?? 1_400_000,
              /* extraSignerPubkeys */ extraSigners.map(k => k.publicKey),
              /* dexLookupTables */ dexLookupTables,
              /* includeRuntimeLut */ false,
            );
            sim = await simulateWithLogs(sendConn, built, [wallet, ...extraSigners]);
          }

          if (sim.value.err) {
            console.warn('[sim] failed:', sim.value.err);
            sim.value.logs?.forEach((l, i) => console.warn(String(i).padStart(2, '0'), l));
            cSimFail.inc();
            consecutiveFails++;
            skipPostProcessing = true;
            if (CFG.haltOnNegativeSim) {
              skipTune = true;
            }
          } else {
            // 👉 Send
            const sig = await sendAndConfirmAny(sendConn, built, [wallet, ...extraSigners]);
            console.log('[send] success', sig);
            cBundlesSent.inc(); sent++;
            cBundlesOk.inc(); ok++; consecutiveFails = 0;
          }
        } catch (e: any) {
          cBundlesSent.inc(); sent++;
          cExecFail.inc(); consecutiveFails++;
          console.error('[send] error', e?.message ?? e);
          skipPostProcessing = true;
        }

        if (!skipTune) {
          tuneFee();
          if (consecutiveFails >= CFG.maxConsecutiveFails) {
            console.error(`[risk] ${consecutiveFails} consecutive fails → cooldown`);
            await new Promise(r => setTimeout(r, 5000));
            consecutiveFails = 0;
          }
        }

        if (skipPostProcessing) {
          continue;
        }
      }

      await new Promise(r => setTimeout(r, CFG.cooldownMs));
    } catch (e) {
      console.error('[loop]', e);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

main().catch(console.error);

