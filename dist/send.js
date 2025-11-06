import { CFG } from './config.js';
export async function simulateWithLogs(connection, built, signers) {
    try {
        if (built.kind === 'legacy') {
            // 👉 Always sign legacy before simulate
            const tx = built.tx;
            tx.sign(...signers);
            const sim = await connection.simulateTransaction(tx, signers);
            if (CFG.debugSim) {
                console.log('[sim] legacy err=', sim.value.err);
                sim.value.logs?.forEach((l, i) => console.log(String(i).padStart(2, '0'), l));
            }
            return sim;
        }
        else {
            // 👉 Always sign v0 before simulate
            const tx = built.tx;
            tx.sign(signers);
            const sim = await connection.simulateTransaction(tx, {
                sigVerify: true,
                commitment: 'processed',
            });
            if (CFG.debugSim) {
                console.log('[sim] v0 err=', sim.value.err);
                sim.value.logs?.forEach((l, i) => console.log(String(i).padStart(2, '0'), l));
            }
            return sim;
        }
    }
    catch (e) {
        console.error('[sim] threw:', e?.message ?? e);
        throw e;
    }
}
export async function sendAndConfirmAny(connection, built, signers) {
    if (built.kind === 'legacy') {
        built.tx.sign(...signers);
        const sig = await connection.sendRawTransaction(built.tx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });
        await connection.confirmTransaction(sig, 'confirmed');
        console.log('[send] sig', sig);
        return sig;
    }
    else {
        const tx = built.tx;
        tx.sign(signers);
        const sig = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
        });
        await connection.confirmTransaction(sig, 'confirmed');
        console.log('[send] sig', sig);
        return sig;
    }
}
//# sourceMappingURL=send.js.map