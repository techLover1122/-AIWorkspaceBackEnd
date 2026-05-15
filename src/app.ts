import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleChatRequest, handleAbortRequest } from "./handlers/chat.js";
import { handleProjectsRequest } from "./handlers/projects.js";
import { handleHistoriesRequest } from "./handlers/histories.js";
import { handleConversationRequest } from "./handlers/conversations.js";
import { handleStatusRequest } from "./handlers/status.js";
import { handleSetApiKey, handleClearAuth } from "./handlers/auth.js";
import {
  handleStartSubscription,
  handleSubscriptionStatus,
  handleCancelSubscription,
  handleSubmitSubscriptionCode,
} from "./handlers/subscription.js";
import type { AppConfig } from "./types.js";

export function createApp(config: AppConfig) {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: ["http://localhost:3000", "http://localhost:3001"],
      credentials: true,
    })
  );

  app.post("/api/chat", handleChatRequest);
  app.post("/api/abort/:requestId", handleAbortRequest);
  app.get("/api/projects", handleProjectsRequest);
  app.get("/api/projects/:encodedProjectName/histories", handleHistoriesRequest);
  app.get("/api/projects/:encodedProjectName/histories/:sessionId", handleConversationRequest);

  app.get("/api/status", handleStatusRequest);
  app.post("/api/auth/api-key", handleSetApiKey);
  app.post("/api/auth/clear", handleClearAuth);
  app.post("/api/auth/subscription/start", handleStartSubscription);
  app.get("/api/auth/subscription/status", handleSubscriptionStatus);
  app.post("/api/auth/subscription/cancel", handleCancelSubscription);
  app.post("/api/auth/subscription/submit-code", handleSubmitSubscriptionCode);
  app.get("/api/health", (c) => c.json({ status: "ok", debug: config.debug }));

  return app;
}
