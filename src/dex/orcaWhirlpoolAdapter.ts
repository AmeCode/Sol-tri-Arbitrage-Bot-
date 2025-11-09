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
import { ensureAtaIx } from '../tokenAta.js';
import { mustAccount } from '../onchain/assertions.js';
import { DexEdge, Quote, BuildIxResult } from './types.js';
import { IS_SIM } from '../runtime.js';

type BNType = InstanceType<typeof BN>;

const DEFAULT_SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? `${CFG.maxSlippageBps ?? 50}`);

function toBN(value: BNType | bigint): BNType {
  return BN.isBN(value) ? (value as BNType) : new BN(value.toString());
}

async function ensureAtaPresent(
  connection: any,
  owner: PublicKey,
  mint: PublicKey,
  label: string,
): Promise<PublicKey> {
  const ensured = ensureAtaIx(owner, owner, mint);
  if (ensured.ixs.length) {
    throw new Error(
      `${label}: missing ATA ${ensured.ata.toBase58()} — run scripts/one_time_setup.ts to create it once`,
    );
  }
  await mustAccount(connection, ensured.ata, label);
  return ensured.ata;
}

async function assertAmount(connection: any, ata: PublicKey, amount: BNType, label: string) {
  const info = await mustAccount(connection, ata, label);
  const decoded = AccountLayout.decode(info.data);
  const available = BigInt(decoded.amount.toString());
  if (available < BigInt(amount.toString())) {
    throw new Error(
      `${label}: ${ata.toBase58()} has ${available} but needs ${amount.toString()} — top up before trading`,
    );
  }
}

export function makeOrcaEdge(
  whirlpool: string,
  mintA: string,
  mintB: string,
  ctx: WhirlpoolContext,
): PoolEdge & DexEdge {
  const poolPk = new PublicKey(whirlpool);
  const client = buildWhirlpoolClient(ctx);
  const quoteUser = ctx.wallet?.publicKey ?? PublicKey.default;

  function getInputMint(from: string): PublicKey {
    if (from === mintA) return new PublicKey(mintA);
    if (from === mintB) return new PublicKey(mintB);
    throw new Error(`orca: direction mismatch: from=${from} not in [${mintA}, ${mintB}]`);
  }

  async function buildLiveSwap(
    amountIn: BNType,
    minOut: BNType,
    user: PublicKey,
  ): Promise<{ bundle: SwapInstructionBundle; liveResult: BuildIxResult }> {
    if (IS_SIM) {
      throw new Error('buildSwapIx called in simulate mode; use quote() only.');
    }

    const pool = await client.getPool(poolPk);
    const inputMint = getInputMint(edge.from);
    const outputMint = edge.from === mintA ? new PublicKey(mintB) : new PublicKey(mintA);
    const slippageBps = DEFAULT_SLIPPAGE_BPS;
    const slippage = Percentage.fromFraction(slippageBps, 10_000);

    const quote = await swapQuoteByInputToken(
      pool,
      inputMint,
      amountIn,
      slippage,
      ctx.program.programId,
      ctx.fetcher,
      { maxAge: 0 },
      UseFallbackTickArray.Never,
    );

    const instructions: TransactionInstruction[] = [];
    const connection = ctx.connection;

    const sourceAta = await ensureAtaPresent(connection, user, inputMint, 'live: orca source ATA');
    const destinationAta = await ensureAtaPresent(connection, user, outputMint, 'live: orca destination ATA');

    if (inputMint.equals(NATIVE_MINT)) {
      await assertAmount(connection, sourceAta, amountIn, 'live: orca WSOL balance');
    } else {
      await assertAmount(connection, sourceAta, amountIn, 'live: orca source balance');
    }

    const params = SwapUtils.getSwapParamsFromQuote(quote, ctx, pool, sourceAta, destinationAta, user);
    const swapInstruction = swapIx(ctx.program, params);
    instructions.push(...swapInstruction.instructions, ...swapInstruction.cleanupInstructions);

    const extraSigners = swapInstruction.signers.filter((signer: Signer): signer is Keypair =>
      Object.prototype.hasOwnProperty.call(signer, 'secretKey'),
    );

    const bundle: SwapInstructionBundle = extraSigners.length
      ? { ixs: instructions, extraSigners, lookupTables: [] }
      : { ixs: instructions, lookupTables: [] };

    const liveResult: BuildIxResult = { ixs: instructions };
    return { bundle, liveResult };
  }

  const edge: any = {
    id: `orca:${whirlpool}`,
    from: mintA,
    to: mintB,
    feeBps: 0,

    async quote(amountIn: BNType, _user: PublicKey): Promise<Quote> {
      if (amountIn.lte(new BN(0))) {
        throw new Error('amountIn must be > 0');
      }
      const pool = await client.getPool(poolPk);
      const inputMint = getInputMint(this.from);
      const slippageBps = DEFAULT_SLIPPAGE_BPS;
      const slippage = Percentage.fromFraction(slippageBps, 10_000);

      const quote = await swapQuoteByInputToken(
        pool,
        inputMint,
        amountIn,
        slippage,
        ctx.program.programId,
        ctx.fetcher,
        { maxAge: 0 },
        UseFallbackTickArray.Never,
      );
      const amountOut = new BN(quote.estimatedAmountOut.toString()) as BNType;
      const feeAmount = new BN(quote.estimatedFeeAmount.toString()) as BNType;
      const minOut = amountOut.muln(10_000 - slippageBps).divn(10_000) as BNType;
      return { amountIn, amountOut, fee: feeAmount, minOut };
    },

    async quoteOut(amountIn: bigint): Promise<bigint> {
      const result = await this.quote(toBN(amountIn), quoteUser);
      return BigInt(result.amountOut.toString());
    },

    async buildSwapIx(amountIn: BNType | bigint, minOut: BNType | bigint, user: PublicKey): Promise<any> {
      const amountBn = toBN(amountIn as BNType | bigint);
      const minOutBn = toBN(minOut as BNType | bigint);
      const { bundle, liveResult } = await buildLiveSwap(amountBn, minOutBn, user);
      if (BN.isBN(amountIn) || BN.isBN(minOut)) {
        return liveResult;
      }
      return bundle;
    },
  };

  return edge as PoolEdge & DexEdge;
}

export function initOrcaCtx(conn: any, walletPk: PublicKey) {
  const dummyWallet = { publicKey: walletPk } as any;
  return WhirlpoolContext.from(conn, dummyWallet, ORCA_WHIRLPOOL_PROGRAM_ID);
}
