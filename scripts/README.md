# Backend scripts

One-time + per-boot provisioning glue for the AI-IDE Studio EC2 image.

## Layout

```
scripts/
├── cloud-init.sh          One-time EC2 user-data script. Provisions apt
│                          deps, Node 20, Claude Code, code-server, clones
│                          backend/frontend, writes systemd units, then
│                          (Step 8) installs the docs/sheets boot recipes.
│                          Fetched by user-data at instance launch via:
│                          curl -fsSL https://raw.githubusercontent.com/
│                                techLover1122/-AIWorkspaceBackEnd/main/
│                                scripts/cloud-init.sh | bash
│
├── recipes/               tmux recipes replayed at every boot by
│   │                      /usr/local/bin/ai-ide-restart-services.sh.
│   │                      cloud-init.sh installs these into
│   │                      ~/.ai-ide/services/ on first provision.
│   ├── employee-todo.sh     Starts employee-todo Next.js on :3456 (hosts
│   │                        the ONLYOFFICE editor iframe at the
│   │                        employees-<USER>.<DOMAIN> subdomain).
│   └── headless-coeditors.sh Launches two long-running headless
│                             Playwright Chromiums inside the ai-ide-
│                             playwright container that hold Document.docx
│                             and Employees.xlsx open so docs-agent /
│                             sheets-agent always have a connected editor.
│
└── headless/              Playwright scripts the recipes run inside the
    │                      ai-ide-playwright container.
    ├── keep-docs-open.mjs   Opens Document.docx, keeps WS session live.
    └── keep-sheets-open.mjs Opens Employees.xlsx, keeps WS session live.
```

## Why the headless co-editors exist

The `docs-agent` (port 4100) and `sheets-agent` (port 4101) sidecars in
`src/agent.ts` bridge MCP tool calls into the ONLYOFFICE editor's JS API
over a WebSocket exposed by the `ai-agent-bridge` plugin
(`src/handlers/plugin.ts`). The plugin only connects while an editor
session is loaded somewhere — originally only the user's browser tab
counted. The headless co-editors are the "Phase 5 follow-up" mode
hinted at in `agent.ts:23-29`: a separate-identity Playwright session
that holds the connection open so MCP `docs_*` / `sheets_*` tools keep
working even when the user closes their tab.

## Installing the recipes by hand

If you're recovering a workspace where Step 8 didn't run:

```bash
mkdir -p ~/.ai-ide/services
install -m 755 scripts/recipes/*.sh ~/.ai-ide/services/
sudo systemctl restart ai-ide-services
```

## Verifying the bridge is live

```bash
curl -s http://localhost:4100/health   # → "connections":1
curl -s http://localhost:4101/health   # → "connections":1
```

Both should report `connections: 1` once the headless sessions warm up
(usually ~8 seconds after the recipe starts). If they sit at 0 the
plugin couldn't reach the agent — check the WebSocket-host mapping in
`src/handlers/plugin.ts:agentWsUrl()` against the iframe's parent host.
