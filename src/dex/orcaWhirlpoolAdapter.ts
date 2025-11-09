import { Keypair, PublicKey, Signer, TransactionInstruction } from '@solana/web3.js';
import {
  WhirlpoolContext,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
  UseFallbackTickArray,
  SwapUtils,
} from '@orca-so/whirlpools-sdk';
import { swapIx } from '@orca-so/whirlpools-sdk/dist/instructions/swap-ix.js';
import { Percentage } from '@orca-so/common-sdk';
import BN from 'bn.js';
import type { PoolEdge, SwapInstructionBundle } from '../graph/types.js';
import { CFG } from '../config.js';
import { NATIVE_MINT, AccountLayout } from '@solana/spl-token';
import { ensureAtaIx, wrapSolIntoAta } from '../tokenAta.js';
import { RUNTIME } from '../runtime.js';
import { mustAccount } from '../onchain/assertions.js';

export function makeOrcaEdge(
  whirlpool: string,
  mintA: string,
  mintB: string,
  ctx: WhirlpoolContext,
): PoolEdge {
  const poolPk = new PublicKey(whirlpool);
  const client = buildWhirlpoolClient(ctx);

  function getInputMint(from: string): PublicKey {
    if (from === mintA) return new PublicKey(mintA);
    if (from === mintB) return new PublicKey(mintB);
    throw new Error(`orca: direction mismatch: from=${from} not in [${mintA}, ${mintB}]`);
  }

  return {
    id: `orca:${whirlpool}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    async quoteOut(amountIn: bigint): Promise<bigint> {
      const pool = await client.getPool(poolPk);
      const inputMint = getInputMint(this.from);
      const slippage = Percentage.fromFraction(CFG.maxSlippageBps, 10_000);

      const quote = await swapQuoteByInputToken(
        pool,
        inputMint,
        new BN(amountIn.toString()),          // BN, not Decimal
        slippage,
        ctx.program.programId,
        ctx.fetcher,
        { maxAge: 0 },                        // <-- VALID SimpleAccountFetchOptions
        UseFallbackTickArray.Never            // (or .Auto / .Always)
      );
      return BigInt(quote.estimatedAmountOut.toString());
    },

    async buildSwapIx(
      amountIn: bigint,
      _minOut: bigint,
      user: PublicKey,
    ): Promise<SwapInstructionBundle> {
      const pool = await client.getPool(poolPk);
      const inputMint = getInputMint(this.from);
      const outputMint = this.from === mintA ? new PublicKey(mintB) : new PublicKey(mintA);
      const slippage = Percentage.fromFraction(CFG.maxSlippageBps, 10_000);

      const quote = await swapQuoteByInputToken(
        pool,
        inputMint,
        new BN(amountIn.toString()),
        slippage,
        ctx.program.programId,
        ctx.fetcher,
        { maxAge: 0 },                        // <-- remove `refresh`
        UseFallbackTickArray.Never
      );

      const instructions: TransactionInstruction[] = [];
      const connection = ctx.connection;

      const ensuredSrc = ensureAtaIx(user, user, inputMint);
      let sourceAta: PublicKey = ensuredSrc.ata;

      if (inputMint.equals(NATIVE_MINT)) {
        if (RUNTIME.mode === 'simulate') {
          if (RUNTIME.requirePrealloc) {
            const info = await mustAccount(connection, sourceAta, 'simulate: orca WSOL ATA');
            const available = BigInt(AccountLayout.decode(info.data).amount.toString());
            if (available < amountIn) {
              throw new Error(
                `simulate: orca WSOL ATA ${sourceAta.toBase58()} has ${available}, needs ${amountIn}`,
              );
            }
          }
        } else {
          if (!RUNTIME.wsolPrewrap) {
            const wrapped = wrapSolIntoAta(user, user, amountIn);
            instructions.push(...wrapped.ixs);
            sourceAta = wrapped.ata;
          } else if (ensuredSrc.ixs.length) {
            instructions.push(...ensuredSrc.ixs);
          }
        }
      } else {
        if (RUNTIME.mode === 'live') {
          if (ensuredSrc.ixs.length) instructions.push(...ensuredSrc.ixs);
        } else if (RUNTIME.requirePrealloc) {
          const info = await mustAccount(connection, sourceAta, 'simulate: orca source ATA');
          const available = BigInt(AccountLayout.decode(info.data).amount.toString());
          if (available < amountIn) {
            throw new Error(
              `simulate: orca source ATA ${sourceAta.toBase58()} has ${available}, needs ${amountIn}`,
            );
          }
        }
      }

      const ensuredDst = ensureAtaIx(user, user, outputMint);
      if (RUNTIME.mode === 'live') {
        if (ensuredDst.ixs.length) instructions.push(...ensuredDst.ixs);
      } else if (RUNTIME.requirePrealloc) {
        await mustAccount(connection, ensuredDst.ata, 'simulate: orca destination ATA');
      }
      const destinationAta = ensuredDst.ata;

      const params = SwapUtils.getSwapParamsFromQuote(
        quote,
        ctx,
        pool,
        sourceAta,
        destinationAta,
        user,
      );

      const swapInstruction = swapIx(ctx.program, params);
      instructions.push(...swapInstruction.instructions);
      instructions.push(...swapInstruction.cleanupInstructions);

      const extraSigners = swapInstruction.signers.filter((signer: Signer): signer is Keypair =>
        Object.prototype.hasOwnProperty.call(signer, 'secretKey'),
      );

      if (extraSigners.length > 0) {
        return { ixs: instructions, extraSigners, lookupTables: [] };
      }

      return { ixs: instructions, lookupTables: [] };
    }
  };
}

export function initOrcaCtx(conn: any, walletPk: PublicKey) {
  const dummyWallet = { publicKey: walletPk } as any;
  return WhirlpoolContext.from(conn, dummyWallet, ORCA_WHIRLPOOL_PROGRAM_ID);
}

