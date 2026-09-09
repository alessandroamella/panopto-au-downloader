#!/usr/bin/env bun
import { main } from "./src/cli";

process.exit(await main(Bun.argv.slice(2)));
