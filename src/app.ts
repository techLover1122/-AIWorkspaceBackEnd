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
import {
  handlePortScan,
  handleRecentPorts,
  handleLogTab,
  handleRecentTabs,
  handleRecentSessions,
} from "./handlers/ports.js";
import {
  handleAddUrl,
  handleListUrls,
  handleDeleteUrl,
  handleRefreshUrl,
  handleListOpenedUrls,
  handleSetOpened,
} from "./handlers/urls.js";
import { handleEvents } from "./handlers/events.js";
import { handleInstallPack } from "./handlers/packs.js";
import { handlePermissionDecision } from "./handlers/permission.js";
import {
  handleListServices,
  handleRegisterService,
} from "./handlers/services.js";
import type { AppConfig } from "./types.js";

export function createApp(config: AppConfig) {
  const app = new Hono();

  // Allow any origin. `credentials: true` is incompatible with the
  // literal "*", so we reflect the request's Origin header back instead —
  // browsers accept that combo. A null return means "no Origin header /
  // unknown" so we fall back to "*" for non-credentialed callers.
  app.use(
    "*",
    cors({
      origin: (origin: string) => origin ?? "*",
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

  // Port + tab + session metadata (SQLite)
  app.get("/api/ports/scan", handlePortScan);
  app.get("/api/ports/history", handleRecentPorts);
  app.post("/api/tabs/log", handleLogTab);
  app.get("/api/tabs/history", handleRecentTabs);
  app.get("/api/sessions/history", handleRecentSessions);

  // Service registry — passthrough to the traefik-router on the proxy
  // EC2. POST /api/services { port, name? } is idempotent and returns
  // { name, port, url } where url is the public domain URL Traefik will
  // route to that port within ~5s.
  app.get("/api/services", handleListServices);
  app.post("/api/services", handleRegisterService);

  // User-curated URLs (new tab page bookmarks)
  app.get("/api/urls", handleListUrls);
  app.get("/api/urls/opened", handleListOpenedUrls);
  app.post("/api/urls", handleAddUrl);
  app.post("/api/urls/opened", handleSetOpened);
  app.delete("/api/urls/:id", handleDeleteUrl);
  app.post("/api/urls/:id/refresh", handleRefreshUrl);

  // SSE channel for tool → frontend events (open_tab, bookmark changes)
  app.get("/api/events", handleEvents);

  // Environment packs — install a Claude-Code-style skill from a URL
  // into ~/.claude/skills/<slug>/.
  app.post("/api/packs/install", handleInstallPack);

  // Permission decision bridge — frontend posts here to resolve a
  // pending canUseTool callback inside an in-flight chat request.
  app.post("/api/permission/:id", handlePermissionDecision);

  app.get("/api/health", (c) => c.json({ status: "ok", debug: config.debug }));

  return app;
}
