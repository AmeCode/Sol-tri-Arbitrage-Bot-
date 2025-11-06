import { SystemInstruction, SystemProgram, } from '@solana/web3.js';
export function assertNoUnwhitelistedAllocations(instructions, payer, allowedSignerPubkeys) {
    const okSet = new Set([payer.toBase58(), ...allowedSignerPubkeys]);
    for (const [idx, ix] of instructions.entries()) {
        if (!ix.programId.equals(SystemProgram.programId))
            continue;
        let ty = null;
        try {
            // decodeInstructionType throws if not a System ix
            // types include: 'Create', 'Allocate', 'Assign', 'Transfer', etc.
            // @ts-ignore types not exported as literal union across versions
            ty = SystemInstruction.decodeInstructionType(ix);
        }
        catch {
            continue;
        }
        if (ty === 'Create' || ty === 'Allocate' || ty === 'AllocateWithSeed' || ty === 'CreateWithSeed') {
            // decode to find the 'new' account (must be a signer unless it's a PDA created by a program… which SystemProgram is not)
            let newAcct = null;
            try {
                // Create{ newAccountPubkey }, Allocate{ accountPubkey }
                const info = SystemInstruction.decodeCreateAccount(ix);
                newAcct = info?.newAccountPubkey ?? null;
            }
            catch {
                try {
                    const info = SystemInstruction.decodeAllocate(ix);
                    newAcct = info?.accountPubkey ?? null;
                }
                catch { /* ignore */ }
            }
            if (newAcct) {
                const need = newAcct.toBase58();
                const signerFlag = ix.keys.find(k => k.pubkey.equals(newAcct))?.isSigner ?? false;
                if (!okSet.has(need) || !signerFlag) {
                    // Fail fast with a super explicit message
                    const keysDump = ix.keys.map(k => ({
                        k: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable,
                    }));
                    throw new Error(`[tx-guard] SystemProgram ${ty} for account ${need} at ix#${idx} requires a signature ` +
                        `but this key is not whitelisted. This usually means an adapter is creating a random ` +
                        `temp account (e.g. WSOL) instead of using an ATA PDA. Keys=${JSON.stringify(keysDump)}`);
                }
            }
        }
    }
}
//# sourceMappingURL=txGuards.js.map