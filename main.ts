// Pump.fun bot sprint entry: an early-snipe paper-trading bot for pump.fun bonding curves.
//
// What the dev tape actually shows: most new coins spike early and then bleed
// out (median coin ends below where it started, while more than half touch +25%
// at some point). Chasing a coin after it has already risen loses on this tape
// in every parameter combination tried. The edge is at the very start: buy a
// coin in its first few trades, near its create price, with a take-profit above
// and a hard stop below. So the bot snipes young coins — first 10 trades,
// price still within 1.4x of create, real reserves already big enough for a
// real buy — and exits on take-profit (+30% over all-in cost), a trailing stop,
// a hard stop (-10%), or staleness. One shot per coin: once a coin has been
// traded the early edge is gone and it is never re-entered.
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
/** Real reserves a coin needs before a buy can be sized (1.5 SOL -> 0.015 cap). */
const MIN_REAL_RESERVE = 1_500_000_000n;
/** Youngest a coin may be to buy: at most this many trades since create. */
const MAX_ENTRY_TRADES = 10;
/** Do not chase a coin already above this multiple of its create price. */
const MAX_ENTRY_MULTIPLE_BPS = 14_000;
/** Take profit: this much (bps) above the all-in cost per token. */
const TAKE_PROFIT_BPS = 3000;
/** Hard stop: this much (bps) below the all-in cost per token. */
const STOP_LOSS_BPS = 1000;
/** Trailing stop arms once the gain reaches this (bps). */
const TRAIL_ARM_BPS = 1500;
/** Trailing stop sells this many bps below the peak gain. */
const TRAIL_DROP_BPS = 800;
/** Buys in the last 3 trades needed for buy pressure. */
const PRESSURE_WINDOW = 3;
const PRESSURE_BUYS = 2;
/** At most this many buys in one batch of orders. */
const MAX_BUYS_PER_BATCH = 3;
/** Sell a held coin with no trade for this many slots. */
const STALE_SLOTS = 400;
/** Sell a held coin after this many slots even if it never triggered. */
const MAX_HOLD_SLOTS = 2000;
/** Max slippage on buys: a buy that would fill worse than this is refused. */
const BUY_SLIPPAGE_BPS = 500;
/** Max slippage on sells: wide, so a stop actually executes in a fast dump. */
const SELL_SLIPPAGE_BPS = 1500;
/** Prices kept per coin (oldest dropped). */
const HISTORY_CAP = 40;

// ---------------------------------------------------------------- per-coin bookkeeping

interface Coin {
  /** Price at the CreateEvent, 0 when the coin was first seen through a trade. */
  createPrice: number;
  /** Trades seen on the coin. */
  trades: number;
  /** Post-trade prices, oldest first. */
  prices: number[];
  /** Slot of the coin's latest trade. */
  lastTradeSlot: number;
  /** is_buy flags of the latest trades, oldest first. */
  lastBuys: boolean[];
  /** True once this bot has bought the coin (one shot per coin). */
  bought: boolean;
  /** Peak gain over entry cost while holding, in bps. */
  peakBps: number;
  /** Slot the current position was opened (first seen held). */
  entrySlot: number;
}

const coins = new Map<string, Coin>();

function coinFor(mint: string): Coin {
  let c = coins.get(mint);
  if (c === undefined) {
    c = {
      createPrice: 0,
      trades: 0,
      prices: [],
      lastTradeSlot: -1,
      lastBuys: [],
      bought: false,
      peakBps: 0,
      entrySlot: -1,
    };
    coins.set(mint, c);
  }
  return c;
}

/** Price in SOL per token from virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

// ---------------------------------------------------------------- run diagnostics (stderr only)

const stats = {
  batches: 0,
  buysSent: 0,
  sellsSent: 0,
  filled: 0,
  rejected: 0,
  failed: 0,
  rejectedByReason: new Map<string, number>(),
};

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    stats.batches++;
    const orders: OrderInput[] = [];
    const slot = state.slot;
    const txFee = state.txFeeLamports();

    // Count how the harness resolved the orders sent earlier.
    for (const f of batch.fills) {
      if (f.status === "filled") stats.filled++;
      else if (f.status === "rejected") {
        stats.rejected++;
        const r = f.reason ?? "unknown";
        stats.rejectedByReason.set(r, (stats.rejectedByReason.get(r) ?? 0) + 1);
      } else if (f.status === "failed") stats.failed++;
    }

    // Fold this batch's events into the per-coin histories first. A coin is
    // only an entry candidate on a slot where it actually traded, which keeps
    // each batch cheap.
    const candidates: string[] = [];
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const c = coinFor(e.mint);
        c.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        c.prices.push(c.createPrice);
        if (c.prices.length > HISTORY_CAP) c.prices.shift();
        c.lastTradeSlot = slot;
      } else if (e.event === "TradeEvent") {
        const c = coinFor(e.mint);
        c.trades++;
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
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        });
        stats.sellsSent++;
        c.entrySlot = -1;
        c.peakBps = 0;
      }
    }

    // Entries: snipe young coins near their create price, one shot each.
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
      if (c === undefined || c.bought) continue;
      // Young only: the early edge is gone after the first few trades.
      if (c.trades > MAX_ENTRY_TRADES) continue;
      // Real reserves must already allow a buy worth sending.
      if (curve.real_quote_reserves < MIN_REAL_RESERVE) continue;
      // Never chase a coin that already ran far above its create price.
      const current = c.prices[c.prices.length - 1];
      if (c.createPrice > 0 && current > 0) {
        const multipleBps = Math.floor((current / c.createPrice) * 10_000);
        if (multipleBps > MAX_ENTRY_MULTIPLE_BPS) continue;
      } else if (current <= 0) {
        continue;
      }
      // Buy pressure: the latest trades should be mostly buys.
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
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      });
      stats.buysSent++;
      buys++;
      c.bought = true;
    }

    return orders;
  },

  onDone(state: BotState): void {
    const cash = state.cash;
    const pnl = cash - BigInt(state.hello.capital.lamports);
    const reasons = [...stats.rejectedByReason.entries()]
      .map(([r, n]) => `${r}:${n}`)
      .join(",");
    console.error(
      `done: cash=${cash} pnl_lamports=${pnl} positions=${state.positions.size} coins_seen=${coins.size} ` +
        `batches=${stats.batches} buys_sent=${stats.buysSent} sells_sent=${stats.sellsSent} ` +
        `filled=${stats.filled} rejected=${stats.rejected} failed=${stats.failed} reject_reasons=${reasons}`,
    );
  },
});
