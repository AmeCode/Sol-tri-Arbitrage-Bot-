import 'dotenv/config';

export type RuntimeMode = 'simulate' | 'live';

export function getRuntimeMode(): RuntimeMode {
  const v = (process.env.RUNTIME_MODE || 'simulate').toLowerCase();
  return v === 'live' ? 'live' : 'simulate';
}

const configuredMode = getRuntimeMode();
let override: RuntimeMode | null = null;

const parsedLutAddresses = (process.env.LUT_ADDRESSES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const IS_SIM = getRuntimeMode() === 'simulate';
export const IS_LIVE = !IS_SIM;

const runtime = {
  get mode(): RuntimeMode {
    return override ?? getRuntimeMode();
  },
  get configuredMode(): RuntimeMode {
    return configuredMode;
  },
  get useLut(): boolean {
    return (override ?? getRuntimeMode()) === 'live' && parsedLutAddresses.length > 0;
  },
  lutAddresses: parsedLutAddresses,
  // In the new architecture we always require preallocated accounts and WSOL liquidity.
  requirePrealloc: true,
  wsolPrewrap: true,
};

export const RUNTIME = runtime;

export async function withRuntimeMode<T>(mode: RuntimeMode, fn: () => Promise<T>): Promise<T> {
  const previous = override;
  override = mode;
  try {
    return await fn();
  } finally {
    override = previous;
  }
}
