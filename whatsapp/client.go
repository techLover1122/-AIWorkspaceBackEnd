package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
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
	ctx       context.Context
	container *sqlstore.Container
	client    *whatsmeow.Client
	webhook   *webhookPoster
	dbPath     string // path to session.db — needed for an on-disk store wipe
	targetFile string // path to target.json — persists the recipient phone

	mu          sync.RWMutex
	currentQR   string    // most recent QR code text from the pairing channel (empty after success)
	qrActive    bool      // pairing flow is currently consuming the channel
	pairingCode string    // most recent phone-pairing code (empty after success)
	lastPairErr string    // last error from the pairing flow (surface to UI)
	target      *types.JID // recipient JID — nil means "self chat" (Message Yourself)
	targetPhone string    // phone form for display (E.164 with leading +)
}

func newClient(ctx context.Context, dbPath, backendURL, authToken string) (*waClient, error) {
	container, err := openContainer(ctx, dbPath)
	if err != nil {
		return nil, err
	}

	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return nil, fmt.Errorf("get first device: %w", err)
	}

	clientLog := waLog.Stdout("Client", "WARN", true)
	cli := whatsmeow.NewClient(device, clientLog)

	wa := &waClient{
		ctx:        ctx,
		container:  container,
		client:     cli,
		webhook:    newWebhookPoster(backendURL, authToken),
		dbPath:     dbPath,
		targetFile: filepath.Join(filepath.Dir(dbPath), "target.json"),
	}
	wa.loadTargetFromDisk()
	cli.AddEventHandler(wa.handleEvent)
	return wa, nil
}

// openContainer opens (creating if absent) the whatsmeow sqlite device
// store at dbPath. Shared by initial startup and the on-disk store wipe
// (hardResetStore) so both paths use identical DSN/journal settings.
func openContainer(ctx context.Context, dbPath string) (*sqlstore.Container, error) {
	dbLog := waLog.Stdout("Database", "WARN", true)
	dsn := "file:" + dbPath + "?_foreign_keys=on&_journal_mode=WAL"
	container, err := sqlstore.New(ctx, "sqlite3", dsn, dbLog)
	if err != nil {
		return nil, fmt.Errorf("open device store: %w", err)
	}
	return container, nil
}

// loadTargetFromDisk repopulates the in-memory target from
// targetFile if it exists. Called once at startup so a configured
// recipient survives sidecar restarts.
func (w *waClient) loadTargetFromDisk() {
	data, err := os.ReadFile(w.targetFile)
	if err != nil {
		return // no target configured yet
	}
	var stored struct {
		Phone string `json:"phone"`
	}
	if json.Unmarshal(data, &stored) != nil || stored.Phone == "" {
		return
	}
	jid := jidFromPhone(stored.Phone)
	if jid == nil {
		return
	}
	w.mu.Lock()
	w.target = jid
	w.targetPhone = "+" + jid.User
	w.mu.Unlock()
}

// jidFromPhone parses a free-form phone string and returns the
// corresponding 1:1 chat JID, or nil if the phone can't be normalized.
func jidFromPhone(phone string) *types.JID {
	clean := normalizePhone(phone)
	if clean == "" {
		return nil
	}
	jid := types.NewJID(clean, types.DefaultUserServer)
	return &jid
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
//
// Self-healing: if the stored session points at a device WhatsApp has
// already removed (e.g. the user deleted it from "Linked Devices", or
// the server expired it), whatsmeow's Connect fails with "invalid use
// of deleted device" and would stay stuck on every boot. We detect that
// case, purge the poisoned session, and kick off a fresh QR pairing so
// the user can simply re-scan — no manual session.db deletion ever
// needed.
func (w *waClient) Connect() error {
	if !w.IsRegistered() {
		return errors.New("device not registered — start pairing first")
	}
	if w.client.IsConnected() {
		return nil
	}
	err := w.client.Connect()
	if isDeletedDeviceErr(err) {
		if rerr := w.resetSession(); rerr != nil {
			return fmt.Errorf("deleted-device recovery failed: %w", rerr)
		}
		// Surface a fresh QR in the background; the /qr poll picks it up.
		go func() { _ = w.BeginQRPairing() }()
		return nil
	}
	return err
}

// isDeletedDeviceErr reports whether an error is whatsmeow's
// "invalid use of deleted device" — the signal that the local session
// references a device WhatsApp no longer recognizes.
func isDeletedDeviceErr(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "deleted device")
}

// resetSession purges the current (poisoned or logged-out) device and
// rebuilds a clean, unregistered client in its place. After this call
// IsRegistered() is false, so a fresh QR/phone pairing can start. Safe
// to call from a goroutine; it swaps w.client under the mutex.
func (w *waClient) resetSession() error {
	if w.client != nil && w.client.IsConnected() {
		w.client.Disconnect()
	}
	// Purge EVERY device row, not just the current one. This is the fix for
	// the recurring "invalid use of deleted device": GetFirstDevice could
	// otherwise hand back a lingering / half-deleted row, and reusing it
	// re-poisons the client on every pairing. Deleting all rows guarantees
	// the store is truly empty before we build a fresh device.
	if devices, derr := w.container.GetAllDevices(w.ctx); derr == nil {
		for _, d := range devices {
			_ = w.container.DeleteDevice(w.ctx, d)
		}
	}
	// NewDevice() always returns a brand-new, never-registered device.
	// Unlike GetFirstDevice it can never return a deleted/poisoned row, so
	// the next pairing always starts from a guaranteed-clean slate.
	device := w.container.NewDevice()
	clientLog := waLog.Stdout("Client", "WARN", true)
	newCli := whatsmeow.NewClient(device, clientLog)
	newCli.AddEventHandler(w.handleEvent)

	w.mu.Lock()
	w.client = newCli
	w.currentQR = ""
	w.pairingCode = ""
	w.qrActive = false
	w.lastPairErr = ""
	w.mu.Unlock()
	return nil
}

// hardResetStore is the nuclear fallback for a poisoned session store
// that the in-process resetSession can't clear: it closes the sqlite
// container, deletes session.db (plus its WAL/SHM sidecars) from disk,
// and rebuilds a brand-new empty store with a fresh unregistered client.
// This is exactly what a manual `rm session.db` + restart does, but
// without operator intervention — so "invalid use of deleted device" can
// never wedge pairing permanently. The recipient override lives in a
// separate target.json and is intentionally left untouched.
func (w *waClient) hardResetStore() error {
	if w.client != nil && w.client.IsConnected() {
		w.client.Disconnect()
	}
	if w.container != nil {
		// Best-effort close so the OS releases the file handles before we
		// unlink. If Close fails we still unlink — on Linux removing an
		// open sqlite file is safe and the orphaned handle is GC'd.
		_ = w.container.Close()
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(w.dbPath + suffix)
	}
	container, err := openContainer(w.ctx, w.dbPath)
	if err != nil {
		return fmt.Errorf("reopen store after wipe: %w", err)
	}
	device := container.NewDevice()
	clientLog := waLog.Stdout("Client", "WARN", true)
	newCli := whatsmeow.NewClient(device, clientLog)
	newCli.AddEventHandler(w.handleEvent)

	w.mu.Lock()
	w.container = container
	w.client = newCli
	w.currentQR = ""
	w.pairingCode = ""
	w.qrActive = false
	w.lastPairErr = ""
	w.mu.Unlock()
	return nil
}

// recoverDeletedDevice escalates the cleanup for a deleted-device error
// by attempt: the first failure gets the cheap in-process purge; any
// later failure wipes the store from disk. Bounded by BeginQRPairing's
// retry cap so it can never spin forever.
func (w *waClient) recoverDeletedDevice(attempt int) error {
	if attempt == 0 {
		return w.resetSession()
	}
	return w.hardResetStore()
}

// recoverFromLogout runs the deleted-device recovery off the whatsmeow
// event loop (calling Disconnect/Connect inline from a handler can
// deadlock), then immediately offers a fresh QR.
func (w *waClient) recoverFromLogout() {
	if err := w.resetSession(); err != nil {
		w.mu.Lock()
		w.lastPairErr = "session reset failed: " + err.Error()
		w.mu.Unlock()
		return
	}
	_ = w.BeginQRPairing()
}

// Status snapshots what the HTTP /status endpoint needs.
type Status struct {
	Paired        bool   `json:"paired"`
	Connected     bool   `json:"connected"`
	JID           string `json:"jid,omitempty"`
	Phone         string `json:"phone,omitempty"`
	PairingCode   string `json:"pairingCode,omitempty"`
	LastError     string `json:"lastError,omitempty"`
	RecipientPhone string `json:"recipientPhone,omitempty"` // empty = self-chat fallback
}

func (w *waClient) Status() Status {
	w.mu.RLock()
	pairingCode := w.pairingCode
	lastErr := w.lastPairErr
	recipient := w.targetPhone
	w.mu.RUnlock()

	s := Status{
		Paired:         w.IsRegistered(),
		Connected:      w.client.IsConnected(),
		PairingCode:    pairingCode,
		LastError:      lastErr,
		RecipientPhone: recipient,
	}
	if w.IsRegistered() {
		id := w.client.Store.ID
		s.JID = id.String()
		s.Phone = "+" + id.User
	}
	return s
}

// SetRecipient configures the outbound JID. Empty phone clears the
// override and falls back to the self-chat. Persists to targetFile so
// a sidecar restart keeps the choice. Returns the cleaned E.164 phone
// (with leading +) so the HTTP layer can echo it back.
func (w *waClient) SetRecipient(phone string) (string, error) {
	if strings.TrimSpace(phone) == "" {
		// Clear → fall back to self.
		w.mu.Lock()
		w.target = nil
		w.targetPhone = ""
		w.mu.Unlock()
		_ = os.Remove(w.targetFile)
		return "", nil
	}
	jid := jidFromPhone(phone)
	if jid == nil {
		return "", errors.New("phone must be in E.164 format, e.g. +14155552671")
	}
	clean := "+" + jid.User
	w.mu.Lock()
	w.target = jid
	w.targetPhone = clean
	w.mu.Unlock()
	// Persist — best-effort; if disk write fails we still keep the
	// in-memory value working for this session.
	data, _ := json.Marshal(map[string]string{"phone": clean})
	_ = os.WriteFile(w.targetFile, data, 0o644)
	return clean, nil
}

// Recipient returns the active outbound JID + display phone. Falls
// back to the linked-account self-JID when no override is configured.
func (w *waClient) recipient() (types.JID, bool) {
	w.mu.RLock()
	override := w.target
	w.mu.RUnlock()
	if override != nil {
		return *override, true
	}
	if w.client.Store == nil || w.client.Store.ID == nil {
		return types.JID{}, false
	}
	self := *w.client.Store.ID
	self.Device = 0
	return self, false
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

	// Escalating self-heal for the recurring "invalid use of deleted
	// device". On each deleted-device failure we clean up harder and retry
	// on a guaranteed-fresh device:
	//   attempt 0 → the device on disk as-is
	//   attempt 1 → after an in-process purge (resetSession)
	//   attempt 2 → after wiping the sqlite store from disk (hardResetStore)
	// A real first-ever pairing always succeeds by attempt 2, so if we
	// somehow still see a deleted-device error we SWALLOW it (return nil on
	// a now-clean, unregistered client) rather than surface the scary
	// string — the next /qr poll simply begins pairing on the fresh device.
	// Non-deleted-device errors (network, outdated client) still surface.
	const maxAttempts = 3
	for attempt := 0; attempt < maxAttempts; attempt++ {
		qrChan, err := w.client.GetQRChannel(w.ctx)
		if err == nil {
			err = w.client.Connect()
		}
		if err == nil {
			go w.consumeQRChannel(qrChan)
			return nil
		}
		if !isDeletedDeviceErr(err) {
			w.mu.Lock()
			w.qrActive = false
			w.lastPairErr = err.Error()
			w.mu.Unlock()
			return fmt.Errorf("begin pairing: %w", err)
		}
		// Deleted device — escalate the cleanup, then retry.
		if rerr := w.recoverDeletedDevice(attempt); rerr != nil {
			w.mu.Lock()
			w.qrActive = false
			w.lastPairErr = "deleted-device recovery failed: " + rerr.Error()
			w.mu.Unlock()
			return fmt.Errorf("deleted-device recovery: %w", rerr)
		}
		w.mu.Lock()
		w.qrActive = true
		w.lastPairErr = ""
		w.mu.Unlock()
	}
	// Retries exhausted on a deleted-device loop. The store was wiped on
	// the last pass, so the client is clean and unregistered — report a
	// no-op success and let the next poll start a fresh pairing.
	w.mu.Lock()
	w.qrActive = false
	w.mu.Unlock()
	return nil
}

// consumeQRChannel drains the pairing QR channel, publishing each emitted
// code into currentQR (polled by /qr) and recording terminal outcomes.
func (w *waClient) consumeQRChannel(qrChan <-chan whatsmeow.QRChannelItem) {
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
			// Same escalating deleted-device self-heal as the QR path:
			// in-process purge first, then an on-disk store wipe if the
			// poison survives — so phone pairing can't get wedged either.
			if !isDeletedDeviceErr(err) {
				return "", fmt.Errorf("connect: %w", err)
			}
			for attempt := 0; ; attempt++ {
				if rerr := w.recoverDeletedDevice(attempt); rerr != nil {
					return "", fmt.Errorf("deleted-device recovery: %w", rerr)
				}
				cerr := w.client.Connect()
				if cerr == nil {
					break
				}
				if !isDeletedDeviceErr(cerr) || attempt >= 1 {
					return "", fmt.Errorf("connect: %w", cerr)
				}
			}
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

// SendText sends a text message to the configured recipient. When no
// recipient is configured this falls back to the paired user's own JID
// (the "Message Yourself" chat) so an unconfigured workspace still has
// a sensible default.
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
	target, _ := w.recipient()
	if target.User == "" {
		return errors.New("no recipient resolved (store empty?)")
	}
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
	w.target = nil
	w.targetPhone = ""
	w.mu.Unlock()
	_ = os.Remove(w.targetFile)
	// Logout deletes the device, which leaves the in-memory client poisoned:
	// every later GetQRChannel/Connect would fail with "invalid use of
	// deleted device". Rebuild a clean, unregistered client so the next
	// pairing starts fresh. This is the bug that kept the error recurring
	// after an unlink — Connect()/LoggedOut already self-heal, but Unlink
	// didn't rebuild the client. resetSession also clears the QR/pairing
	// state, so we no longer do that by hand here.
	return w.resetSession()
}

// handleEvent is the whatsmeow event sink. We only care about incoming
// text messages from the paired user themselves — the agent's "owner".
// Any other event is ignored (logged at debug only).
func (w *waClient) handleEvent(evt interface{}) {
	switch v := evt.(type) {
	case *events.Message:
		w.handleMessage(v)
	case *events.LoggedOut:
		// The device was removed (from the phone's Linked Devices or by
		// the server). The in-memory device is now poisoned — keeping it
		// makes every later Connect() fail with "invalid use of deleted
		// device" forever. Purge it and start a fresh QR off the event
		// loop so the user just re-scans; no manual session reset needed.
		//
		// Log the full event so the *reason* is visible in
		// `journalctl -u ai-ide-whatsapp` — this tells a genuine unlink
		// apart from a server-side version removal (whatsmeow #984) or an
		// expiry, which is the difference between "user did it" and "we
		// need to update whatsmeow".
		fmt.Printf("whatsapp: LoggedOut %+v — purging session, offering fresh QR\n", v)
		go w.recoverFromLogout()
	case *events.StreamReplaced:
		// Another client connected with THIS device's credentials. If this
		// fires without the user opening WhatsApp Web elsewhere, it means a
		// second sidecar instance is running against the same session.db —
		// a deployment bug that also shows up as device removals.
		fmt.Printf("whatsapp: StreamReplaced — another client took over this device (duplicate sidecar?)\n")
	case *events.ConnectFailure:
		// Surfaces the server's reason for refusing the connection (e.g.
		// client-outdated), which is the upstream trigger for repeated
		// device removals.
		fmt.Printf("whatsapp: ConnectFailure %+v\n", v)
	}
}

func (w *waClient) handleMessage(m *events.Message) {
	// Inbound filter — ONLY the user's own account may drive the agent:
	//   * Recipient configured → accept ONLY that recipient's INCOMING
	//     replies in the 1:1 chat with them.
	//   * No recipient (default) → accept ONLY the user's OWN self-chat
	//     ("Message Yourself").
	// Everything else is ignored: other contacts (incoming OR the user's
	// own outbound to them), groups, broadcasts/status, and the device's
	// own outbound echoes. The previous default-mode check accepted ANY
	// IsFromMe message, so the user's conversations with other people
	// leaked into the agent panel — that's the bug this closes.
	self := w.client.Store.ID
	if self == nil {
		return // not paired — nothing legitimate can arrive
	}
	w.mu.RLock()
	override := w.target
	w.mu.RUnlock()

	chat := m.Info.Chat
	// Only ever consider plain 1:1 user chats. WhatsApp now addresses chats
	// via EITHER the classic phone-number server (s.whatsapp.net) OR the new
	// privacy LID server (@lid) — the "Message Yourself" self-chat in
	// particular arrives LID-addressed. Accept both; groups (g.us),
	// broadcasts, status (status@broadcast) and newsletters live on other
	// servers and must never reach the agent. (Rejecting @lid here was the
	// bug that silently dropped every inbound self-chat prompt — chat.Server
	// "lid" failed the old DefaultUserServer-only check before the webhook
	// ever fired.)
	if chat.Server != types.DefaultUserServer && chat.Server != types.HiddenUserServer {
		return
	}

	if override != nil && override.User != self.User {
		// Recipient is a DIFFERENT contact — accept only THEIR incoming
		// replies (their messages, not our own outbound echo to them).
		if chat.User != override.User || m.Info.IsFromMe {
			return
		}
	} else {
		// Default self-chat ("Message Yourself"), OR an override pointing at
		// the user's OWN number. The only legitimate driver is the user's own
		// self-chat message: it is IsFromMe AND the conversation is with
		// themselves — i.e. the chat JID and the sender JID are the same
		// account. Comparing chat.User == sender.User identifies the self-chat
		// robustly under BOTH phone-number and @lid addressing, WITHOUT
		// needing to resolve our own LID (which differs from self.User). It
		// also does NOT match messages the user sends to other people — there
		// the chat is the other party and the sender is us, so the users
		// differ — which is the leak the old check guarded against.
		if !m.Info.IsFromMe || chat.User != m.Info.Sender.User {
			return
		}
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
