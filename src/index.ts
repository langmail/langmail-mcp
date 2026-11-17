#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.ts";

// stdout belongs to the MCP transport: nothing else may write to it.
await createServer().connect(new StdioServerTransport());
