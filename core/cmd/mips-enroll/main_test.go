package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOAuthCallbackChecksStateAndConsumesOneCode(t *testing.T) {
	codes := make(chan string, 1)
	callback := oauthCallback("/api/webhook/42", "expected", codes)
	request := func(method, path string) int {
		rec := httptest.NewRecorder()
		callback.ServeHTTP(rec, httptest.NewRequest(method, "http://homeassistant.local:8123"+path, nil))
		return rec.Code
	}
	if got := request("GET", "/api/webhook/42?state=wrong&code=unexpected"); got != http.StatusBadRequest {
		t.Fatalf("wrong state returned %d", got)
	}
	if got := request("GET", "/api/webhook/42?state=expected&code=approved"); got != http.StatusOK {
		t.Fatalf("valid callback returned %d", got)
	}
	if got := request("GET", "/api/webhook/42?state=expected&code=replay"); got != http.StatusConflict {
		t.Fatalf("replayed callback returned %d", got)
	}
	if got := <-codes; got != "approved" {
		t.Fatalf("wrong authorization code %q", got)
	}
}
