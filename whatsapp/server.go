package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	qrcode "github.com/skip2/go-qrcode"
)

// newRouter wires the HTTP API. Every route requires the shared bearer
// token in the Authorization header — the Node backend sets this from
// the WHATSAPP_AUTH_TOKEN env var the cloud-init also bakes into the
// sidecar's systemd unit, so the two sides agree without manual setup.
func newRouter(wa *waClient, authToken string) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("/status", auth(authToken, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, wa.Status())
	}))

	mux.HandleFunc("/qr", auth(authToken, func(w http.ResponseWriter, r *http.Request) {
		// Kick off pairing if not already running. The pairing
		// goroutine writes the latest QR code into wa.currentQR.
		if !wa.IsRegistered() {
			if err := wa.BeginQRPairing(); err != nil {
				writeErr(w, http.StatusConflict, err)
				return
			}
		}
		qr, paired := wa.CurrentQR()
		// Render the QR string to a PNG and base64-encode it so the
		// frontend can drop it straight into an <img src="data:..."/>
		// without pulling in a QR npm package. 256px ≈ the right size
		// for the modal; medium ECC matches WhatsApp's own settings.
		var dataURL string
		if qr != "" {
			png, err := qrcode.Encode(qr, qrcode.Medium, 256)
			if err == nil {
				dataURL = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"qr":       qr,
			"qrPngUrl": dataURL,
			"paired":   paired,
		})
	}))

	mux.HandleFunc("/pair-phone", auth(authToken, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, errors.New("POST required"))
			return
		}
		var body struct {
			Phone string `json:"phone"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		code, err := wa.BeginPhonePairing(body.Phone)
		if err != nil {
			writeErr(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"pairingCode": code})
	}))

	mux.HandleFunc("/send", auth(authToken, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, errors.New("POST required"))
			return
		}
		var body struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, err)
			return
		}
		if err := wa.SendText(body.Text); err != nil {
			writeErr(w, http.StatusBadGateway, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	mux.HandleFunc("/unlink", auth(authToken, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeErr(w, http.StatusMethodNotAllowed, errors.New("POST required"))
			return
		}
		if err := wa.Unlink(); err != nil {
			writeErr(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}))

	return mux
}

// auth returns a handler that 401s anything missing the shared bearer.
// constant-time-ish comparison is fine here — the token is long enough
// that timing attacks aren't realistic against a localhost socket, and
// the cost of being wrong is "another local process on the EC2 spoofs
// the sidecar", which the threat model already trusts.
func auth(token string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if got == "" || got != token {
			writeErr(w, http.StatusUnauthorized, errors.New("bad token"))
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
