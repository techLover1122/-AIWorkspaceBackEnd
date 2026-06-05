import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { handleChatRequest, handleAbortRequest } from "./handlers/chat.js";
import {
  handleChatStreamRequest,
  handleActiveTasksRequest,
} from "./handlers/chatStream.js";
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
import { handleIntentGuardDecision } from "./handlers/intentGuard.js";
import {
  handleListServices,
  handleRegisterService,
} from "./handlers/services.js";
import {
  handleEditorConfig,
  handleCallback,
  handleFileFetch,
  handleFileUpload,
} from "./handlers/office.js";
import {
  handlePluginConfig,
  handlePluginIndex,
  handlePluginJs,
} from "./handlers/plugin.js";
import {
  handleWhatsAppStatus,
  handleWhatsAppQr,
  handleWhatsAppPairPhone,
  handleWhatsAppUnlink,
  handleWhatsAppIncoming,
} from "./handlers/whatsapp.js";
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
  app.get("/api/chat/stream/:taskId", handleChatStreamRequest);
  app.get("/api/chat/active", handleActiveTasksRequest);
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

  // Office editors — bridges to the pre-installed ONLYOFFICE Docs
  // Server containers (docs:4000 / sheets:4001). See handlers/office.ts.
  //   POST /api/office/config           → signed editor config
  //   POST /api/office/callback         → ONLYOFFICE save loop
  //   GET  /api/office/file/:fileId     → ONLYOFFICE fetches docs here
  //   PUT  /api/office/file/:fileId     → seed/replace file bytes
  app.post("/api/office/config", handleEditorConfig);
  app.post("/api/office/callback", handleCallback);
  app.get("/api/office/file/:fileId", handleFileFetch);
  app.put("/api/office/file/:fileId", handleFileUpload);

  // ai-agent-bridge ONLYOFFICE plugin — three static assets served from
  // this backend (rather than bind-mounted into the Docs containers).
  // The editor config's `plugins.pluginsData` points at config.json and
  // `plugins.autostart` triggers loading on every doc/sheet open. See
  // handlers/plugin.ts for the loading topology.
  app.get("/api/plugin/ai-agent-bridge/config.json", handlePluginConfig);
  app.get("/api/plugin/ai-agent-bridge/index.html", handlePluginIndex);
  app.get("/api/plugin/ai-agent-bridge/plugin.js", handlePluginJs);

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

  // Intent Guard decision bridge — frontend posts the user's chosen
  // interpretation (narrow/broad) before the SDK query starts.
  app.post("/api/intent-guard/:id", handleIntentGuardDecision);

  // WhatsApp integration — pairing/status proxied to the Go sidecar
  // on 127.0.0.1:8091 (ai-ide-whatsapp.service), webhook receives
  // incoming messages and routes them to permission decisions /
  // AskUserQuestion answers / new chat turns. See handlers/whatsapp.ts
  // and utils/whatsappBridge.ts. Configured via WHATSAPP_AUTH_TOKEN +
  // WHATSAPP_SIDECAR_URL in /etc/workspace.env.
  app.get("/api/whatsapp/status", handleWhatsAppStatus);
  app.get("/api/whatsapp/qr", handleWhatsAppQr);
  app.post("/api/whatsapp/pair-phone", handleWhatsAppPairPhone);
  app.post("/api/whatsapp/unlink", handleWhatsAppUnlink);
  app.post("/api/whatsapp/incoming", handleWhatsAppIncoming);

  app.get("/api/health", (c: Context) => c.json({ status: "ok", debug: config.debug }));

  return app;
}
