export function sleep(ms) {
    return new Promise(res => setTimeout(res, ms));
}
export async function withBackoff(fn, opts = {}) {
    const retries = opts.retries ?? 5;
    const base = opts.baseMs ?? 200;
    const max = opts.maxMs ?? 2000;
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        }
        catch (err) {
            if (attempt >= retries)
                throw err;
            const exp = Math.min(max, base * Math.pow(2, attempt));
            const jitter = Math.floor(Math.random() * (exp * 0.25));
            const delay = exp + jitter;
            opts.onRetry?.(err, attempt + 1, delay);
            await sleep(delay);
            attempt++;
        }
    }
}
//# sourceMappingURL=retry.js.map