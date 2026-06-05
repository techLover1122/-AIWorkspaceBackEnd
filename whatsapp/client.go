package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"go.mau.fi/whatsmeow"
	waProto "go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

// waClient wraps the whatsmeow client with the bits we need: a current-
// QR holder for the polling endpoint, a webhook poster for incoming
// messages, and a thin Send/Connect/Logout surface for the HTTP layer.
type waClient struct {
	ctx        context.Context
	container  *sqlstore.Container
	client     *whatsmeow.Client
	webhook    *webhookPoster

	mu          sync.RWMutex
	currentQR   string // most recent QR code text from the pairing channel (empty after success)
	qrActive    bool   // pairing flow is currently consuming the channel
	pairingCode string // most recent phone-pairing code (empty after success)
	lastPairErr string // last error from the pairing flow (surface to UI)
}

func newClient(ctx context.Context, dbPath, backendURL, authToken string) (*waClient, error) {
	dbLog := waLog.Stdout("Database", "WARN", true)
	dsn := "file:" + dbPath + "?_foreign_keys=on&_journal_mode=WAL"
	container, err := sqlstore.New(ctx, "sqlite3", dsn, dbLog)
	if err != nil {
		return nil, fmt.Errorf("open device store: %w", err)
	}

	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return nil, fmt.Errorf("get first device: %w", err)
	}

	clientLog := waLog.Stdout("Client", "WARN", true)
	cli := whatsmeow.NewClient(device, clientLog)

	wa := &waClient{
		ctx:       ctx,
		container: container,
		client:    cli,
		webhook:   newWebhookPoster(backendURL, authToken),
	}
	cli.AddEventHandler(wa.handleEvent)
	return wa, nil
}

func (w *waClient) Close() {
	if w.client != nil && w.client.IsConnected() {
		w.client.Disconnect()
	}
}

// IsRegistered reports whether a session is already paired on disk. If
// true, Connect() will resume the session without a fresh QR scan.
func (w *waClient) IsRegistered() bool {
	return w.client.Store != nil && w.client.Store.ID != nil
}

// Connect dials WhatsApp and starts receiving events for an already-
// registered device. Returns an error if the device is unregistered —
// callers should use BeginQRPairing instead.
func (w *waClient) Connect() error {
	if !w.IsRegistered() {
		return errors.New("device not registered — start pairing first")
	}
	if w.client.IsConnected() {
		return nil
	}
	return w.client.Connect()
}

// Status snapshots what the HTTP /status endpoint needs.
type Status struct {
	Paired      bool   `json:"paired"`
	Connected   bool   `json:"connected"`
	JID         string `json:"jid,omitempty"`
	Phone       string `json:"phone,omitempty"`
	PairingCode string `json:"pairingCode,omitempty"`
	LastError   string `json:"lastError,omitempty"`
}

func (w *waClient) Status() Status {
	w.mu.RLock()
	pairingCode := w.pairingCode
	lastErr := w.lastPairErr
	w.mu.RUnlock()

	s := Status{
		Paired:      w.IsRegistered(),
		Connected:   w.client.IsConnected(),
		PairingCode: pairingCode,
		LastError:   lastErr,
	}
	if w.IsRegistered() {
		id := w.client.Store.ID
		s.JID = id.String()
		s.Phone = "+" + id.User
	}
	return s
}

// CurrentQR returns the most recently emitted QR code from the pairing
// channel, plus whether pairing succeeded. The HTTP layer polls this
// every second or two until paired.
func (w *waClient) CurrentQR() (qr string, paired bool) {
	w.mu.RLock()
	defer w.mu.RUnlock()
	return w.currentQR, w.IsRegistered()
}

// BeginQRPairing kicks off the QR pairing loop in a background
// goroutine. The latest QR code is stored on the client; the HTTP layer
// surfaces it via CurrentQR(). Idempotent — subsequent calls while a
// pairing is in flight are no-ops.
func (w *waClient) BeginQRPairing() error {
	w.mu.Lock()
	if w.IsRegistered() {
		w.mu.Unlock()
		return errors.New("already paired — unlink first")
	}
	if w.qrActive {
		w.mu.Unlock()
		return nil
	}
	w.qrActive = true
	w.lastPairErr = ""
	w.mu.Unlock()

	qrChan, err := w.client.GetQRChannel(w.ctx)
	if err != nil {
		w.mu.Lock()
		w.qrActive = false
		w.lastPairErr = err.Error()
		w.mu.Unlock()
		return fmt.Errorf("get qr channel: %w", err)
	}
	if err := w.client.Connect(); err != nil {
		w.mu.Lock()
		w.qrActive = false
		w.lastPairErr = err.Error()
		w.mu.Unlock()
		return fmt.Errorf("connect: %w", err)
	}

	go func() {
		for evt := range qrChan {
			switch evt.Event {
			case "code":
				w.mu.Lock()
				w.currentQR = evt.Code
				w.mu.Unlock()
			case "success":
				w.mu.Lock()
				w.currentQR = ""
				w.qrActive = false
				w.mu.Unlock()
				return
			case "timeout":
				w.mu.Lock()
				w.lastPairErr = "pairing timed out — refresh QR to try again"
				w.qrActive = false
				w.mu.Unlock()
				return
			case "err-client-outdated":
				w.mu.Lock()
				w.lastPairErr = "whatsmeow client is outdated — rebuild the sidecar"
				w.qrActive = false
				w.mu.Unlock()
				return
			default:
				if evt.Error != nil {
					w.mu.Lock()
					w.lastPairErr = evt.Error.Error()
					w.qrActive = false
					w.mu.Unlock()
					return
				}
			}
		}
	}()
	return nil
}

// BeginPhonePairing asks WhatsApp for a phone-number pairing code. The
// returned code is shown to the user, who enters it under "Linked
// Devices → Link with phone number" in their WhatsApp app. Returns the
// 8-character code (typically formatted XXXX-XXXX).
func (w *waClient) BeginPhonePairing(phone string) (string, error) {
	if w.IsRegistered() {
		return "", errors.New("already paired — unlink first")
	}
	clean := normalizePhone(phone)
	if clean == "" {
		return "", errors.New("phone must be in E.164 format, e.g. +14155552671")
	}
	// PairPhone requires the client to be Connected (it does the
	// handshake over the existing socket). Connect anonymously first.
	if !w.client.IsConnected() {
		if err := w.client.Connect(); err != nil {
			return "", fmt.Errorf("connect: %w", err)
		}
	}
	code, err := w.client.PairPhone(w.ctx, clean, true,
		whatsmeow.PairClientChrome, "Chrome (AI IDE)")
	if err != nil {
		return "", fmt.Errorf("pair phone: %w", err)
	}
	w.mu.Lock()
	w.pairingCode = code
	w.lastPairErr = ""
	w.mu.Unlock()
	return code, nil
}

// SendText sends a text message to the paired user's own JID (i.e. the
// "Message Yourself" chat). Used for outbound agent notifications.
func (w *waClient) SendText(text string) error {
	if !w.IsRegistered() {
		return errors.New("not paired")
	}
	if !w.client.IsConnected() {
		return errors.New("not connected — try again in a moment")
	}
	if strings.TrimSpace(text) == "" {
		return errors.New("text is empty")
	}
	target := *w.client.Store.ID
	target.Device = 0 // address the user, not a specific device
	msg := &waProto.Message{Conversation: proto.String(text)}
	ctx, cancel := context.WithTimeout(w.ctx, 15*time.Second)
	defer cancel()
	_, err := w.client.SendMessage(ctx, target, msg)
	return err
}

// Unlink logs the device out of WhatsApp (the user sees this device
// disappear from "Linked Devices") and clears the local session so the
// next pairing starts fresh.
func (w *waClient) Unlink() error {
	if !w.IsRegistered() {
		return nil
	}
	if err := w.client.Logout(w.ctx); err != nil {
		// Even if logout fails (network), nuke the local store so we
		// don't stay stuck "paired but unusable" on the next boot.
		w.client.Disconnect()
	}
	w.mu.Lock()
	w.currentQR = ""
	w.pairingCode = ""
	w.qrActive = false
	w.mu.Unlock()
	return nil
}

// handleEvent is the whatsmeow event sink. We only care about incoming
// text messages from the paired user themselves — the agent's "owner".
// Any other event is ignored (logged at debug only).
func (w *waClient) handleEvent(evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		w.handleMessage(v)
	case *events.LoggedOut:
		// User unlinked from their phone; we'll naturally lose the
		// session and a re-pair is needed next time.
		w.mu.Lock()
		w.currentQR = ""
		w.pairingCode = ""
		w.mu.Unlock()
	}
}

func (w *waClient) handleMessage(m *events.Message) {
	// Only accept messages from the paired user. IsFromMe covers
	// messages the user sends from their own phone / Web — the natural
	// "Message Yourself" surface. Treating only those as agent input
	// prevents random WhatsApp contacts from driving the agent.
	if !m.Info.IsFromMe {
		return
	}
	text := extractText(m.Message)
	if text == "" {
		return
	}
	payload := IncomingWebhook{
		MessageID: m.Info.ID,
		FromJID:   m.Info.Sender.String(),
		ChatJID:   m.Info.Chat.String(),
		Text:      text,
		Timestamp: m.Info.Timestamp.Unix(),
	}
	if err := w.webhook.Post(payload); err != nil {
		fmt.Printf("webhook post failed: %v\n", err)
	}
}

// extractText flattens the whatsmeow Message into the plain text the
// user typed. Handles Conversation, ExtendedTextMessage, and the
// commonly-seen "edit message" + reaction variants by ignoring them.
func extractText(m *waProto.Message) string {
	if m == nil {
		return ""
	}
	if m.GetConversation() != "" {
		return m.GetConversation()
	}
	if ext := m.GetExtendedTextMessage(); ext != nil {
		return ext.GetText()
	}
	return ""
}

func normalizePhone(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	// Strip leading + and any non-digit so PairPhone gets a clean
	// E.164-without-plus string.
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if len(out) < 7 || len(out) > 15 {
		return ""
	}
	return out
}

// Compile-time check that the JID accessor exists on the version we
// pinned — keeps refactors honest.
var _ = types.JID{}
