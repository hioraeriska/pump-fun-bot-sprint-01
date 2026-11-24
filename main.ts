// Pump.fun bot sprint entry: a momentum paper-trading bot for pump.fun bonding curves.
//
// The idea is simple and it comes from the dev tape itself: most new coins spike
// early and then bleed out (median coin ends below where it started, while more
// than half touch +25% at some point). So the bot buys a coin only after it has
// already shown real upward momentum with buy pressure, rides the pump with a
// take-profit and a trailing stop, and cuts losers fast with a hard stop. It never
// chases a coin that is already far gone, never holds a dead coin, and never
// risks more than a small fixed size per coin.
//
// Money is paper only: the bot trades a replay of chain data, starts with 10 SOL
// of paper cash, and every decision comes from the replay events alone. It reads
// no clock, no environment and no randomness, so two runs on the same tape give
// the same action log byte for byte.
//
// hello — the wire is the kit's vendor shim (vendor/makefun-bot.ts): it speaks
// agent-fun/replay/v2 on stdin/stdout, one batch of orders per slot, and it owns
// the hello / batch / done handshake. This file only decides the orders.

import { runBot, type Batch, type BotState, type OrderInput } from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tuning

/** SOL spent per entry (0.05 SOL). */
const BUY_SIZE = 50_000_000n;
/** Smallest buy worth sending (0.015 SOL): below this a round trip cannot count. */
const MIN_BUY = 15_000_000n;
/** Entry: price up this much (bps) off the recent low, with buy pressure. */
const ENTRY_RISE_BPS = 1000;
/** Re-entry into a coin already traded needs a stronger move. */
const REENTRY_RISE_BPS = 1500;
/** Take profit: this much (bps) above the all-in cost per token. */
const TAKE_PROFIT_BPS = 2200;
/** Hard stop: this much (bps) below the all-in cost per token. */
const STOP_LOSS_BPS = 700;
/** Trailing stop arms once the gain reaches this (bps). */
const TRAIL_ARM_BPS = 1000;
/** Trailing stop sells this many bps below the peak gain. */
const TRAIL_DROP_BPS = 1000;
/** Trades a coin needs before it can be bought. */
const MIN_TRADES = 8;
/** Lookback window (trades) for the recent low. */
const LOOKBACK = 15;
/** Buys in the last 5 trades needed for buy pressure. */
const PRESSURE_WINDOW = 5;
const PRESSURE_BUYS = 3;
/** At most this many buys in one batch of orders. */
const MAX_BUYS_PER_BATCH = 3;
/** Sell a held coin with no trade for this many slots. */
const STALE_SLOTS = 400;
/** Sell a held coin after this many slots even if it never triggered. */
const MAX_HOLD_SLOTS = 2000;
/** Max slippage the harness may take against the decision-time price. */
const SLIPPAGE_BPS = 500;
/** Prices kept per coin (oldest dropped). */
const HISTORY_CAP = 40;

// ---------------------------------------------------------------- per-coin bookkeeping

interface Coin {
  /** Post-trade prices, oldest first. */
  prices: number[];
  /** Slot of the coin's latest trade. */
  lastTradeSlot: number;
  /** is_buy flags of the latest trades, oldest first. */
  lastBuys: boolean[];
  /** True once this bot has completed a round trip on the coin. */
  traded: boolean;
  /** Peak gain over entry cost while holding, in bps. */
  peakBps: number;
  /** Slot the current position was opened (first seen held). */
  entrySlot: number;
}

const coins = new Map<string, Coin>();

function coinFor(mint: string): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = { prices: [], lastTradeSlot: -1, lastBuys: [], traded: false, peakBps: 0, entrySlot: -1 };
    coins.set(mint, c);
  }
  return c;
}

/** Price in SOL per token from virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = state.slot;
    const txFee = state.txFeeLamports();

    // Fold this batch's events into the per-coin histories first. The batch
    // carries this slot's orders too: a coin is only a candidate on a slot
    // where it actually traded, which keeps each batch cheap.
    const candidates: string[] = [];
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const c = coinFor(e.mint);
        c.prices.push(priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)));
        if (c.prices.length > HISTORY_CAP) c.prices.shift();
        c.lastTradeSlot = slot;
      } else if (e.event === "TradeEvent") {
        const c = coinFor(e.mint);
        c.prices.push(priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)));
        if (c.prices.length > HISTORY_CAP) c.prices.shift();
        c.lastBuys.push(e.is_buy);
        if (c.lastBuys.length > PRESSURE_WINDOW) c.lastBuys.shift();
        c.lastTradeSlot = slot;
        candidates.push(e.mint);
      } else {
        // CompleteEvent: the curve is done; the harness closes positions itself.
        coinFor(e.mint);
      }
    }

    // Exits first: free slots and lock in gains before opening anything new.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      // Never double-sell a coin with a sell already in flight.
      let sellPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === "sell" && p.order.mint === mint) {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;

      const c = coinFor(mint);
      const mark = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const cost = Number(holding.cost_lamports) / Number(holding.token_amount);
      if (cost <= 0 || mark <= 0) continue;
      const gainBps = Math.floor(((mark - cost) / cost) * 10_000);

      if (c.entrySlot < 0) {
        c.entrySlot = slot;
        c.peakBps = gainBps;
      } else if (gainBps > c.peakBps) {
        c.peakBps = gainBps;
      }

      const stale = slot - c.lastTradeSlot > STALE_SLOTS;
      const tooLong = slot - c.entrySlot > MAX_HOLD_SLOTS;
      const takeProfit = gainBps >= TAKE_PROFIT_BPS;
      const stopLoss = gainBps <= -STOP_LOSS_BPS;
      const trailing =
        c.peakBps >= TRAIL_ARM_BPS && gainBps <= c.peakBps - TRAIL_DROP_BPS;

      if (takeProfit || stopLoss || trailing || stale || tooLong) {
        orders.push({
          side: "sell",
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        c.traded = true;
        c.entrySlot = -1;
        c.peakBps = 0;
      }
    }

    // Entries: momentum with buy pressure, only on coins that traded now.
    let buys = 0;
    for (const mint of candidates) {
      if (buys >= MAX_BUYS_PER_BATCH) break;
      if (state.committedPositionCount() + buys >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;

      let buyPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === "buy" && p.order.mint === mint) {
          buyPending = true;
          break;
        }
      }
      if (buyPending) continue;

      const c = coins.get(mint);
      if (c === undefined || c.prices.length < MIN_TRADES) continue;
      const window = c.prices.slice(-LOOKBACK);
      let low = window[0];
      for (const p of window) if (p < low) low = p;
      const current = c.prices[c.prices.length - 1];
      if (low <= 0 || current <= 0) continue;
      const riseBps = Math.floor(((current - low) / low) * 10_000);
      const need = c.traded ? REENTRY_RISE_BPS : ENTRY_RISE_BPS;
      if (riseBps < need) continue;

      let buyCount = 0;
      for (const b of c.lastBuys) if (b) buyCount++;
      if (buyCount < PRESSURE_BUYS) continue;

      const cap = state.maxBuyLamports(mint);
      let size = BUY_SIZE;
      if (size > cap) size = cap;
      if (size < MIN_BUY) continue;
      if (state.freeCashLamports() - BigInt(buys) * (BUY_SIZE + txFee) < size + txFee) continue;

      orders.push({
        side: "buy",
        mint,
        quote_lamports: size,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      buys++;
    }

    return orders;
  },

  onDone(state: BotState): void {
    const cash = state.cash;
    const pnl = cash - BigInt(state.hello.capital.lamports);
    console.error(
      `done: cash=${cash} pnl_lamports=${pnl} positions=${state.positions.size} coins_seen=${coins.size}`,
    );
  },
});
