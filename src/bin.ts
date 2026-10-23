#!/usr/bin/env node
import { runCli } from "./cli/main.ts";
import { runMcpServer } from "./mcp/main.ts";

const argv = process.argv.slice(2);
if (argv[0] === "mcp") await runMcpServer();
else process.exitCode = await runCli(argv);
