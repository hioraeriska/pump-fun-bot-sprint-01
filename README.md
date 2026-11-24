[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/hioraeriska/pump-fun-bot-sprint-01/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/hioraeriska/pump-fun-bot-sprint-01/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint: Make Bot And Win

A momentum paper-trading bot for pump.fun bonding curves, entered in the
[make.fun bounty](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed).

## Strategy

Most new coins spike early and then bleed out, so the bot buys only after a coin
has already shown real upward momentum with buy pressure, rides the pump with a
take-profit (+30% over all-in cost) and a hard stop (-15%). It never chases a coin
that is already far gone, never holds a dead coin (stale exit after 400 quiet slots), and risks a small fixed
size (0.05 SOL) per coin, at most 5 open positions.

Everything is paper money on a replay of chain data. Every decision comes from
the replay events alone — no clock, no environment, no randomness — so two runs
on the same tape produce the same action log byte for byte.

## Layout

- `main.ts` — the bot (entrypoint, run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's protocol shim (agent-fun/replay/v2)

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --bundle <transcripts.tar.gz>
```
