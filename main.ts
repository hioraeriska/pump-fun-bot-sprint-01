// Pump.fun bot sprint entry: entrypoint. The strategy lives in strategy.ts;
// this file only wires it to the kit's protocol shim and runs it.
//
// The grader runs `node /bot/main.ts` (Node 22 strips the types; no build,
// no install). The bot speaks agent-fun/replay/v2 on stdin/stdout, reads no
// clock, no environment and no randomness, so two runs on the same tape give
// the same action log byte for byte. Paper money only.

import { runBot } from "./vendor/makefun-bot.ts";
import { createBot } from "./strategy.ts";

await runBot(createBot());
