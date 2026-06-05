// ai-ide-whatsapp — Go sidecar that owns the WhatsApp pairing + transport.
//
// The Node backend (Hono on :8090) cannot speak the WhatsApp protocol —
// the canonical client is whatsmeow, which is Go. So we run a tiny HTTP
// server on 127.0.0.1:8091 with a stable JSON API:
//
//   GET  /status         — { paired, jid?, phone? }
//   GET  /qr             — { qr?, paired }   (poll until paired==true)
//   POST /pair-phone     — { phone } → { pairingCode } (alternative to QR)
//   POST /send           — { text } → { ok }   (sends to the paired user's own JID)
//   POST /unlink         — {} → { ok }
//
// On incoming messages from the paired user (IsFromMe=true — i.e. messages
// the user typed on their phone in their own "Message Yourself" chat or
// any thread they reply to), we POST to the backend webhook
// (BACKEND_WEBHOOK_URL) so the chat handler can route the message as
// either a permission decision, an AskUserQuestion answer, or a fresh
// chat turn against the most recent session.
//
// Authentication: all API calls require a shared bearer token
// (WHATSAPP_AUTH_TOKEN). The sidecar listens on 127.0.0.1 only so
// nothing outside the EC2 can reach it directly, but the token also
// gates the webhook so a stray local process can't spoof "incoming
// WhatsApp messages" to the backend.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

type config struct {
	listenAddr   string
	sessionDir   string
	backendURL   string
	authToken    string
}

func loadConfig() config {
	addr := envOr("LISTEN_ADDR", "127.0.0.1:8091")
	dir := envOr("SESSION_DIR", "/var/lib/ai-ide/whatsapp")
	backend := envOr("BACKEND_WEBHOOK_URL", "http://127.0.0.1:8090/api/whatsapp/incoming")
	token := os.Getenv("WHATSAPP_AUTH_TOKEN")
	if token == "" {
		log.Fatalf("WHATSAPP_AUTH_TOKEN env var is required")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Fatalf("create session dir %q: %v", dir, err)
	}
	return config{
		listenAddr: addr,
		sessionDir: dir,
		backendURL: backend,
		authToken:  token,
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	cfg := loadConfig()
	log.Printf("ai-ide-whatsapp starting: listen=%s session=%s backend=%s",
		cfg.listenAddr, cfg.sessionDir, cfg.backendURL)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dbPath := filepath.Join(cfg.sessionDir, "session.db")
	wa, err := newClient(ctx, dbPath, cfg.backendURL, cfg.authToken)
	if err != nil {
		log.Fatalf("client init: %v", err)
	}
	defer wa.Close()

	// If the device store already has a registered ID, reconnect on
	// boot so incoming messages start flowing without waiting for the
	// first /qr poll.
	if wa.IsRegistered() {
		if err := wa.Connect(); err != nil {
			log.Printf("auto-connect on boot: %v", err)
		}
	}

	srv := &http.Server{
		Addr:              cfg.listenAddr,
		Handler:           newRouter(wa, cfg.authToken),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("HTTP listening on %s", cfg.listenAddr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("listen: %v", err)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	log.Printf("shutting down")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	_ = srv.Shutdown(shutdownCtx)
}
