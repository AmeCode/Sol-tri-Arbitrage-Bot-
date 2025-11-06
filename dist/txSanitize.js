import { TransactionInstruction } from '@solana/web3.js';
export function sanitizeWithSignerWhitelist(instructions, payer, allowedSigners) {
    const keep = new Set([payer.toBase58(), ...allowedSigners]);
    return instructions.map(ix => {
        const keys = ix.keys.map(k => ({
            pubkey: k.pubkey,
            isWritable: k.isWritable,
            isSigner: keep.has(k.pubkey.toBase58()),
        }));
        return new TransactionInstruction({
            programId: ix.programId,
            keys,
            data: ix.data,
        });
    });
}
//# sourceMappingURL=txSanitize.js.map