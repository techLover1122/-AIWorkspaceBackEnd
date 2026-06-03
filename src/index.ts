import "dotenv/config";
import { serve } from "@hono/node-server";
import type { Server as HttpServer } from "node:http";
import { createApp } from "./app.js";
import { attachTerminalWebSocket } from "./handlers/terminal.js";
import { info } from "./utils/logger.js";
import { warmStartClaudeCli } from "./utils/claudeCli.js";

const port = parseInt(process.env.PORT ?? "8090", 10);
const host = process.env.HOST ?? "127.0.0.1";
const debug = process.env.DEBUG === "true";

async function main() {
  const detected = await warmStartClaudeCli(process.env.CLAUDE_PATH);
  if (detected) {
    process.env.CLAUDE_PATH = detected;
  }

  const app = createApp({ port, host, debug, claudePath: detected });

  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: host,
    },
    () => {
      info(`Server running at http://${host}:${port}`);
      info(`Debug mode: ${debug}`);
    }
  );

  // Attach the terminal WebSocket route to the underlying HTTP server.
  // Hono itself only handles fetch-style HTTP — we hook `upgrade`
  // directly on the node server for the PTY bridge.
  attachTerminalWebSocket(server as unknown as HttpServer);
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
