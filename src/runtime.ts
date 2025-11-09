import 'dotenv/config';

type RuntimeMode = 'simulate' | 'live';

const configuredMode = (process.env.MODE ?? 'simulate').toLowerCase() as RuntimeMode;
let modeOverride: RuntimeMode | null = null;

const runtime = {
  get mode(): RuntimeMode {
    return modeOverride ?? configuredMode;
  },
  configuredMode,
  useLut: (process.env.USE_LUT ?? 'true') === 'true',
  lutAddresses: (process.env.LUT_ADDRESSES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  requirePrealloc: (process.env.REQUIRE_PREALLOC ?? 'true') === 'true',
  wsolPrewrap: (process.env.WSOL_PREWRAP ?? 'false') === 'true',
};

export const RUNTIME: {
  readonly mode: RuntimeMode;
  readonly configuredMode: RuntimeMode;
  useLut: boolean;
  lutAddresses: string[];
  requirePrealloc: boolean;
  wsolPrewrap: boolean;
} = runtime;

export async function withRuntimeMode<T>(
  mode: RuntimeMode,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = modeOverride;
  modeOverride = mode;
  try {
    return await fn();
  } finally {
    modeOverride = previous;
  }
}
