import type { Context } from "hono";

/**
 * The `ai-agent-bridge` ONLYOFFICE plugin — three static assets served
 * from this backend so we don't have to bind-mount anything into the
 * Docs Server containers.
 *
 * Loading topology:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  Editor (docs-<userId>... or sheets-<userId>...)                 │
 *   │  ┌─────────────────────────────────────────────────────────────┐ │
 *   │  │  <iframe src="https://api-<userId>.../api/plugin/.../       │ │
 *   │  │            index.html">                                     │ │
 *   │  │  ┌───────────────────────────────────────────────────────┐  │ │
 *   │  │  │  index.html inline bootstrap:                         │  │ │
 *   │  │  │    1. Detects parent origin via document.referrer     │  │ │
 *   │  │  │    2. Loads /sdkjs-plugins/v1/plugins.js               │  │ │
 *   │  │  │       FROM THAT ORIGIN (docs-/sheets- subdomain)       │  │ │
 *   │  │  │    3. Loads plugin.js (same origin as iframe)          │  │ │
 *   │  │  │  ──────────────────────────────────────────────────    │  │ │
 *   │  │  │  plugin.js:                                            │  │ │
 *   │  │  │    - Opens WS to docs-agent-<userId> or sheets-agent-  │  │ │
 *   │  │  │      <userId> (derived from parent's hostname)         │  │ │
 *   │  │  │    - Dispatches incoming { id, op, args } messages by  │  │ │
 *   │  │  │      passing into Asc.plugin.callCommand               │  │ │
 *   │  │  │    - Sends { id, result } back over WS                 │  │ │
 *   │  │  └───────────────────────────────────────────────────────┘  │ │
 *   │  └─────────────────────────────────────────────────────────────┘ │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * The plugin's GUID is hardcoded into the editor config's autostart list
 * (see handlers/office.ts), so opening any doc/sheet brings the plugin
 * up automatically — no user click required.
 */

export const PLUGIN_GUID = "asc.{e4cef5d9-2fa9-4d10-a55f-c2bb1c3ee9d9}";

const CONFIG_JSON = JSON.stringify(
  {
    name: "AI Agent Bridge",
    guid: PLUGIN_GUID,
    baseUrl: "",
    minVersion: "5.4.0",
    variations: [
      {
        description:
          "Bridges editor JS API calls to the docs-agent / sheets-agent sidecar over WebSocket. Background plugin — no UI.",
        url: "index.html",
        // Background plugin — runs without a button click.
        isVisual: false,
        // Allowed even when the document is opened in view-only mode.
        isViewer: true,
        // Both editor types load it; plugin.js routes by editorType.
        EditorsSupport: ["word", "cell"],
        events: [],
        buttons: [],
      },
    ],
  },
  null,
  2
);

// index.html is intentionally tiny. The interesting bit is the inline
// bootstrap that detects the parent editor's origin via document.referrer
// and pulls plugins.js from there — that way the cross-origin
// postMessage handshake the SDK does is between the iframe and its
// actual parent (the editor), with the SDK code running in the iframe.
const INDEX_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>AI Agent Bridge</title>
  <script>
    (function () {
      var parentOrigin = "";
      try { parentOrigin = new URL(document.referrer).origin; } catch (e) {}
      // Fallback: if referrer is empty (strict referrer-policy), assume
      // the editor is on the same parent of window.top — best-effort.
      if (!parentOrigin) {
        try { parentOrigin = window.parent.location.origin; } catch (e) {
          parentOrigin = window.location.origin;
        }
      }
      function loadScript(src, onload) {
        var s = document.createElement("script");
        s.src = src;
        s.async = false;
        if (onload) s.onload = onload;
        document.head.appendChild(s);
      }
      loadScript(parentOrigin + "/sdkjs-plugins/v1/plugins.js", function () {
        loadScript(parentOrigin + "/sdkjs-plugins/v1/plugins-ui.js", function () {
          loadScript("plugin.js");
        });
      });
    })();
  </script>
</head>
<body></body>
</html>
`;

// The plugin runtime. ECMAScript 5-ish (no const/let, arrow functions
// fine inside callCommand which the editor evaluates in its own context
// — but I'm keeping the outer scope ES5 to maximize compat with older
// embedded WebViews if anyone ever opens the editor in one).
//
// Hot path: WS message → Asc.scope.{__op,__args} → callCommand → result
// → WS response. Asc.scope is the documented way to bridge data into
// the macro sandbox; closures DO NOT cross the boundary because the
// function is .toString()'d and re-evaluated.
const PLUGIN_JS = `(function () {
  "use strict";

  var ws = null;
  var reconnectTimer = null;
  var editorType = null; // "word" | "cell" (set in init)

  function agentWsUrl() {
    // Parent editor's host: docs-<USER>.<DOMAIN> or sheets-<USER>.<DOMAIN>.
    // Insert "-agent" after "docs" or "sheets" prefix → docs-agent-<USER>.<DOMAIN>.
    var parentHost = "";
    try { parentHost = new URL(document.referrer).host; } catch (e) {}
    if (!parentHost) {
      try { parentHost = window.parent.location.host; } catch (e) {
        parentHost = window.location.host;
      }
    }
    // Primary mapping: docs-<USER>.<DOMAIN> → docs-agent-<USER>.<DOMAIN>.
    // Aliases: when edit/page.tsx rewrites the script URL to port-4000-
    // (because the docs- subdomain is broken on this workspace), the
    // editor iframe lives there too — map it to the docs agent. Same
    // for port-4001- → sheets-agent-. Replacements are mutually
    // exclusive: pick the first prefix that matches, otherwise leave
    // parentHost unchanged (lets the agent reject unknown hosts cleanly).
    var wsHost;
    if (/^port-4000-/.test(parentHost)) {
      wsHost = parentHost.replace(/^port-4000-/, "docs-agent-");
    } else if (/^port-4001-/.test(parentHost)) {
      wsHost = parentHost.replace(/^port-4001-/, "sheets-agent-");
    } else if (/^(docs|sheets)-/.test(parentHost)) {
      wsHost = parentHost.replace(/^(docs|sheets)-/, "$1-agent-");
    } else {
      wsHost = parentHost;
    }
    var scheme = window.location.protocol === "https:" ? "wss" : "ws";
    return scheme + "://" + wsHost + "/plugin";
  }

  function send(obj) {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(obj)); } catch (e) {}
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, 2000);
  }

  function connect() {
    var url;
    try { url = agentWsUrl(); } catch (e) { scheduleReconnect(); return; }
    try { ws = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }

    ws.onopen = function () {
      send({ type: "hello", editorType: editorType });
    };
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      handleCommand(msg);
    };
    ws.onclose = function () { ws = null; scheduleReconnect(); };
    ws.onerror = function () { try { ws.close(); } catch (_) {} };
  }

  function handleCommand(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ping") { send({ type: "pong", id: msg.id }); return; }
    if (typeof msg.id !== "number" || typeof msg.op !== "string") return;

    // Asc.scope is the documented bridge into callCommand's sandbox.
    Asc.scope.__op = msg.op;
    Asc.scope.__args = msg.args || {};

    Asc.plugin.callCommand(function () {
      var op = Asc.scope.__op;
      var args = Asc.scope.__args;
      try {
        switch (op) {
          /* ─── sheets ops (XLSX / "cell" editor) ─── */
          case "sheets_set_value": {
            Api.GetActiveSheet().GetRange(args.cell).SetValue(args.value);
            return { ok: true };
          }
          case "sheets_set_range": {
            Api.GetActiveSheet().GetRange(args.range).SetValue(args.values);
            return { ok: true };
          }
          case "sheets_get_range": {
            return { ok: true, value: Api.GetActiveSheet().GetRange(args.range).GetValue() };
          }
          case "sheets_set_formula": {
            Api.GetActiveSheet().GetRange(args.cell).SetValue("=" + String(args.formula));
            return { ok: true };
          }
          case "sheets_clear_range": {
            Api.GetActiveSheet().GetRange(args.range).Clear();
            return { ok: true };
          }
          case "sheets_list_sheets": {
            var sheets = Api.GetSheets();
            var names = [];
            for (var i = 0; i < sheets.length; i++) names.push(sheets[i].GetName());
            return { ok: true, names: names };
          }
          case "sheets_add_sheet": {
            Api.AddSheet(args.name);
            return { ok: true };
          }

          /* ─── docs ops (DOCX / "word" editor) ─── */
          case "docs_get_text": {
            return { ok: true, text: Api.GetDocument().GetText() };
          }
          case "docs_insert_text": {
            var doc = Api.GetDocument();
            var last = doc.GetElement(doc.GetElementsCount() - 1);
            last.AddText(args.text);
            return { ok: true };
          }
          case "docs_replace_text": {
            Api.GetDocument().SearchAndReplace({
              SearchString: args.find,
              ReplaceString: args.replace,
              MatchCase: args.matchCase === true
            });
            return { ok: true };
          }
          case "docs_apply_heading": {
            var range = Api.GetDocument().GetRangeBySelect();
            if (!range) return { ok: false, error: "no selection" };
            var style = Api.GetDocument().GetStyle("Heading " + (args.level || 1));
            range.SetStyle(style);
            return { ok: true };
          }

          default:
            return { ok: false, error: "unknown op: " + op };
        }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    }, /* isClose */ false, /* isCalc */ false, function (result) {
      send({ id: msg.id, result: result });
    });
  }

  window.Asc = window.Asc || {};
  window.Asc.plugin = window.Asc.plugin || {};

  window.Asc.plugin.init = function () {
    editorType = (Asc.plugin.info && Asc.plugin.info.editorType) || null;
    connect();
  };
  window.Asc.plugin.button = function () {};
  window.Asc.plugin.onTranslate = function () {};
})();
`;

/* ───────────────────────── handlers ───────────────────────── */

/**
 * The three handlers are intentionally dumb static-content servers.
 * Caching is OK at the edge (the assets are immutable until a backend
 * release), but during dev we'd rather see fresh content — so set a
 * short cache time.
 */

function staticResponse(c: Context, body: string, contentType: string) {
  c.header("Content-Type", contentType);
  c.header("Cache-Control", "public, max-age=60");
  // Plugin assets are fetched cross-origin by ONLYOFFICE — be explicit.
  c.header("Access-Control-Allow-Origin", "*");
  return c.body(body);
}

export function handlePluginConfig(c: Context) {
  return staticResponse(c, CONFIG_JSON, "application/json; charset=utf-8");
}

export function handlePluginIndex(c: Context) {
  return staticResponse(c, INDEX_HTML, "text/html; charset=utf-8");
}

export function handlePluginJs(c: Context) {
  return staticResponse(
    c,
    PLUGIN_JS,
    "application/javascript; charset=utf-8"
  );
}
