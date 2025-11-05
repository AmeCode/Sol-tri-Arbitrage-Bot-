import { CFG } from './config.js';
import { makeConnections } from './rpc.js';
import { buildEdges } from './graph/builder.js';
import { findTriCandidates } from './graph/findTri.js';
import { bestSize } from './sizing.js';
import { startMetrics, cBundlesOk, cBundlesSent, cSimFail, cExecFail, gIncludeRatio, gPriorityFee, cScansTotal } from './metrics.js';
import { Keypair, PublicKey, Connection, sendAndConfirmTransaction, TransactionInstruction, VersionedTransaction, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { ensureLutHas } from './lut.js';
import { buildAndMaybeLut, getRuntimeLutAddress, setRuntimeLutAddress } from './tx.js';

function allowedByHopCount(pathLen: number, lutExists: boolean) {
  if (pathLen <= CFG.maxHops) return true;
  if (pathLen === 3 && CFG.allowThirdHop && lutExists) return true;
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

  const { read: readConn, send: sendConn } = makeConnections();
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
        let amountIn = sized.inAmount;
        for (let i = 0; i < path.length; i++) {
          const edge = path[i];
          const minOut = hopQuotes[i];
          const ixSet = await edge.buildSwapIx(amountIn, minOut, wallet.publicKey);
          swapIxs.push(...ixSet);
          amountIn = minOut;
        }

        const { tx, lutAddressUsed } = await buildAndMaybeLut(
          sendConn,
          wallet.publicKey,
          wallet,
          swapIxs,
          priorityFee,
        );

        if (lutAddressUsed) {
          setRuntimeLutAddress(lutAddressUsed);
          console.log('[lut] used', lutAddressUsed.toBase58());
        }

        // Simulate exact tx
        console.log('[sim] simulating tx...');
        let simOk = true;
        try {
          if (tx instanceof VersionedTransaction) {
            tx.sign([wallet]);
            const sim = await readConn.simulateTransaction(tx, {
              sigVerify: false,
              replaceRecentBlockhash: false,
            });
            simOk = !sim.value.err;
            if (!simOk) {
              console.warn('[sim] err', sim.value.err);
            }
          } else {
            const sim = await readConn.simulateTransaction(tx, [wallet]);
            simOk = !sim.value.err;
            if (!simOk) {
              console.warn('[sim] err', sim.value.err);
            }
          }
        } catch (e) {
          console.warn('[sim] exception', (e as Error)?.message ?? e);
          simOk = false;
        }

        if (!simOk) {
          cSimFail.inc(); consecutiveFails++;
          if (CFG.haltOnNegativeSim) continue;
        }

        try {
          cBundlesSent.inc(); sent++;
          let sig: string;
          if (tx instanceof VersionedTransaction) {
            sig = await (sendAndConfirmTransaction as any)(sendConn, tx, {
              skipPreflight: false,
              commitment: 'confirmed',
            });
          } else {
            tx.sign(wallet);
            sig = await sendAndConfirmTransaction(sendConn, tx, [wallet], {
              skipPreflight: false,
              commitment: 'confirmed',
            });
          }
          console.log('[send] sig', sig);
          cBundlesOk.inc(); ok++; consecutiveFails = 0;
        } catch (e) {
          console.error('[bundle/send] error', e);
          cExecFail.inc(); consecutiveFails++;
        }

        tuneFee();
        if (consecutiveFails >= CFG.maxConsecutiveFails) {
          console.error(`[risk] ${consecutiveFails} consecutive fails → cooldown`);
          await new Promise(r => setTimeout(r, 5000));
          consecutiveFails = 0;
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

