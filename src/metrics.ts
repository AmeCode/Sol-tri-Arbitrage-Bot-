import express, { Request, Response } from 'express';
import { Registry, collectDefaultMetrics, Gauge, Counter } from 'prom-client';
import { CFG } from './config.js';

const reg = new Registry();
collectDefaultMetrics({ register: reg });

export const gIncludeRatio = new Gauge({ name: 'arb_include_ratio', help: 'confirmed/sent', registers: [reg] });
export const gPriorityFee  = new Gauge({ name: 'arb_priority_fee', help: 'microLamports', registers: [reg] });
export const cBundlesSent  = new Counter({ name: 'arb_bundles_sent_total', help: 'bundles sent', registers: [reg] });
export const cBundlesOk    = new Counter({ name: 'arb_bundles_ok_total', help: 'bundles included', registers: [reg] });
export const cSimFail      = new Counter({ name: 'arb_sim_fail_total', help: 'simulation fails', registers: [reg] });
export const cExecFail     = new Counter({ name: 'arb_exec_fail_total', help: 'send fails', registers: [reg] });
export const cScansTotal   = new Counter({ name: 'arb_scans_total', help: 'arb loop iterations', registers: [reg] });

export function startMetrics() {
  const app = express();
  app.get('/metrics', async (_req: Request, res: Response) => {
    res.set('Content-Type', reg.contentType);
    res.end(await reg.metrics());
  });
  app.listen(CFG.metricsPort, () => console.log(`[metrics] listening on :${CFG.metricsPort}/metrics`));
}

