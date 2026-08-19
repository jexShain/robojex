#!/usr/bin/env node
// packages/takeoverd/src/index.ts
import { ModeStateMachine } from "./modes.js";
import { ScreenPipeline } from "./screen.js";
import { InputInjector } from "./input.js";
import { HotkeyWatcher } from "./hotkey.js";
import { TakeoverServer } from "./server.js";
import { NullCdp, PuppeteerCdp, type CdpChannel } from "./cdp.js";

const rawPort = process.argv.find((a, i, arr) => arr[i - 1] === "--port") ?? "7600";
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`takeoverd: invalid --port ${JSON.stringify(rawPort)}: must be an integer in 1-65535`);
  process.exit(1);
}

async function main(): Promise<void> {
  const modes = new ModeStateMachine();            // boots in observe — safe default
  const screen = new ScreenPipeline();
  const injector = new InputInjector(modes);
  const hotkey = new HotkeyWatcher();
  // CDP bridge: attach when a local Chrome debug port answers, degrade silently otherwise
  let cdp: CdpChannel = new NullCdp();
  const puppeteerCdp = new PuppeteerCdp();
  if (await puppeteerCdp.available()) cdp = puppeteerCdp;
  const server = new TakeoverServer({ modes, injector, screen, hotkey, cdp, port });

  screen.start(1000);                              // observe cadence: 1 fps
  hotkey.start();
  await server.start(port);
  console.log(`takeoverd listening on :${port}, mode=${modes.current}`);

  const shutdown = async () => { screen.stop(); hotkey.stop(); await server.stop(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main();
