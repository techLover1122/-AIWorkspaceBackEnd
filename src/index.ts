import "dotenv/config";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
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

  serve(
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
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
