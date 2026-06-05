package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// IncomingWebhook is the JSON body posted to the Node backend whenever
// the paired user sends a WhatsApp message. The backend uses this to
// either resolve a pending permission / AskUserQuestion or to kick off
// a fresh /api/chat turn against the most recent session.
type IncomingWebhook struct {
	MessageID string `json:"messageId"`
	FromJID   string `json:"fromJid"`
	ChatJID   string `json:"chatJid"`
	Text      string `json:"text"`
	Timestamp int64  `json:"timestamp"`
}

type webhookPoster struct {
	url       string
	authToken string
	http      *http.Client
}

func newWebhookPoster(url, authToken string) *webhookPoster {
	return &webhookPoster{
		url:       url,
		authToken: authToken,
		http:      &http.Client{Timeout: 10 * time.Second},
	}
}

func (p *webhookPoster) Post(payload IncomingWebhook) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, p.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+p.authToken)
	resp, err := p.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("backend webhook returned %s", resp.Status)
	}
	return nil
}
