// Strategy for the pump.fun bot sprint: snipe young coins near their create
// price and exit on a take-profit or a hard stop.
//
// What the dev tape shows: most new coins spike early and then bleed out
// (median coin ends below where it started, while more than half touch +25%
// at some point). Chasing a coin after it has already risen loses on this tape
// in every parameter combination tried. The edge is at the very start: buy a
// coin in its first few trades, near its create price, with a take-profit above
// and a hard stop below. So the bot snipes young coins — first 10 trades,
// price still within 1.4x of create, real reserves already big enough for a
// real buy — and exits on take-profit, a hard stop, or staleness. One shot per
// coin: once a coin has been traded the early edge is gone and it is never
// re-entered.
//
// Money is paper only: the bot trades a replay of chain data, starts with 10 SOL
// of paper cash, and every decision comes from the replay events alone. It reads
// no clock, no environment and no randomness, so two runs on the same tape give
// the same action log byte for byte.
//
// hello — the wire is the kit's vendor shim (vendor/makefun-bot.ts): it speaks
// agent-fun/replay/v2 on stdin/stdout, one batch of orders per slot, and it owns
// the hello / batch / done handshake. This file only decides the orders.

import type { Batch, Bot, BotState, OrderInput } from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tuning

export interface Params {
  /** SOL spent per entry, in lamports. */
  buySizeLamports: bigint;
  /** Smallest buy worth sending, in lamports. */
  minBuyLamports: bigint;
  /** Real reserves a coin needs before a buy can be sized, in lamports. */
  minRealReserveLamports: bigint;
  /** Youngest a coin may be to buy: at most this many trades since create. */
  maxEntryTrades: number;
  /** Do not chase a coin above this multiple of its create price, in bps. */
  maxEntryMultipleBps: number;
  /** Take profit: this much (bps) above the all-in cost per token. */
  takeProfitBps: number;
  /** Hard stop: this much (bps) below the all-in cost per token. */
  stopLossBps: number;
  /** Buys in the last 3 trades needed for buy pressure. */
  pressureBuys: number;
  /** At most this many buys in one batch of orders. */
  maxBuysPerBatch: number;
  /** Sell a held coin with no trade for this many slots. */
  staleSlots: number;
  /** Sell a held coin after this many slots even if it never triggered. */
  maxHoldSlots: number;
  /** Max slippage on buys, in bps. */
  buySlippageBps: number;
  /** Max slippage on sells, in bps. Wide, so a stop executes in a fast dump. */
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  buySizeLamports: 50_000_000n,
  minBuyLamports: 15_000_000n,
  minRealReserveLamports: 1_500_000_000n,
  maxEntryTrades: 10,
  maxEntryMultipleBps: 14_000,
  takeProfitBps: 3000,
  stopLossBps: 1500,
  pressureBuys: 2,
  maxBuysPerBatch: 3,
  staleSlots: 400,
  maxHoldSlots: 2000,
  buySlippageBps: 500,
  sellSlippageBps: 1500,
};

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
  /** Slot the current position was opened (first seen held). */
  entrySlot: number;
}

/** Price in SOL per token from virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

// ---------------------------------------------------------------- the bot

export function createBot(params: Params = DEFAULT_PARAMS): Bot {
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
        entrySlot: -1,
      };
      coins.set(mint, c);
    }
    return c;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const orders: OrderInput[] = [];
      const slot = state.slot;
      const txFee = state.txFeeLamports();

      // Fold this batch's events into the per-coin histories first. A coin is
      // only an entry candidate on a slot where it actually traded, which keeps
      // each batch cheap.
      const candidates: string[] = [];
      for (const e of batch.events) {
        if (e.event === "CreateEvent") {
          const c = coinFor(e.mint);
          c.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          c.prices.push(c.createPrice);
          if (c.prices.length > 40) c.prices.shift();
          c.lastTradeSlot = slot;
        } else if (e.event === "TradeEvent") {
          const c = coinFor(e.mint);
          c.trades++;
          c.prices.push(priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)));
          if (c.prices.length > 40) c.prices.shift();
          c.lastBuys.push(e.is_buy);
          if (c.lastBuys.length > 3) c.lastBuys.shift();
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

        if (c.entrySlot < 0) c.entrySlot = slot;

        const stale = slot - c.lastTradeSlot > params.staleSlots;
        const tooLong = slot - c.entrySlot > params.maxHoldSlots;
        const takeProfit = gainBps >= params.takeProfitBps;
        const stopLoss = gainBps <= -params.stopLossBps;

        if (takeProfit || stopLoss || stale || tooLong) {
          orders.push({
            side: "sell",
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: params.sellSlippageBps,
          });
          c.entrySlot = -1;
        }
      }

      // Entries: snipe young coins near their create price, one shot each.
      let buys = 0;
      for (const mint of candidates) {
        if (buys >= params.maxBuysPerBatch) break;
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
        if (c.trades > params.maxEntryTrades) continue;
        // Real reserves must already allow a buy worth sending.
        if (curve.real_quote_reserves < params.minRealReserveLamports) continue;
        // Never chase a coin that already ran far above its create price.
        const current = c.prices[c.prices.length - 1];
        if (c.createPrice > 0 && current > 0) {
          const multipleBps = Math.floor((current / c.createPrice) * 10_000);
          if (multipleBps > params.maxEntryMultipleBps) continue;
        } else if (current <= 0) {
          continue;
        }
        // Buy pressure: the latest trades should be mostly buys.
        let buyCount = 0;
        for (const b of c.lastBuys) if (b) buyCount++;
        if (buyCount < params.pressureBuys) continue;

        const cap = state.maxBuyLamports(mint);
        let size = params.buySizeLamports;
        if (size > cap) size = cap;
        if (size < params.minBuyLamports) continue;
        if (state.freeCashLamports() - BigInt(buys) * (params.buySizeLamports + txFee) < size + txFee) continue;

        orders.push({
          side: "buy",
          mint,
          quote_lamports: size,
          max_slippage_bps: params.buySlippageBps,
        });
        buys++;
        c.bought = true;
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
  };
}
