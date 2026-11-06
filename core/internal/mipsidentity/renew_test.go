package mipsidentity

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type transportFunc func(*http.Request) (*http.Response, error)

func (f transportFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestRenewPreservesIdentityAndRotatedTokenAcrossSigningFailure(t *testing.T) {
	now := time.Now()
	path := filepath.Join(t.TempDir(), "identity.json")
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	current := Identity{VirtualDID: "42", UID: "12345", DeviceID: "ha.test", RefreshToken: "refresh-0"}
	subject := clientSubject(current.UID, current.VirtualDID)
	makeCert := func(publicKey any, validFor time.Duration) string {
		t.Helper()
		cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: subject, NotBefore: now.Add(-time.Minute), NotAfter: now.Add(validFor)}
		der, err := x509.CreateCertificate(rand.Reader, cert, cert, publicKey, key)
		if err != nil {
			t.Fatal(err)
		}
		return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
	}
	current.Cert = makeCert(key.Public(), time.Hour)
	current.Key, err = encodeKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := SaveNew(path, current); err != nil {
		t.Fatal(err)
	}

	refreshes := 0
	client := &http.Client{Transport: transportFunc(func(req *http.Request) (*http.Response, error) {
		body := ""
		switch req.URL.Path {
		case "/app/v2/ha/oauth/get_token":
			var data map[string]any
			if err := json.Unmarshal([]byte(req.URL.Query().Get("data")), &data); err != nil {
				t.Fatal(err)
			}
			if data["refresh_token"] != fmt.Sprintf("refresh-%d", refreshes) || data["redirect_uri"] != RedirectURI("42") {
				t.Fatal("wrong refresh request")
			}
			refreshes++
			body = fmt.Sprintf(`{"code":0,"result":{"access_token":"access","refresh_token":"refresh-%d"}}`, refreshes)
		case "/app/v2/ha/oauth/get_central_crt":
			if req.Header.Get("Authorization") != "Beareraccess" {
				t.Fatal("missing signing authorization")
			}
			var data struct{ CSR string }
			if err := json.NewDecoder(req.Body).Decode(&data); err != nil {
				t.Fatal(err)
			}
			csrPEM, err := base64.StdEncoding.DecodeString(data.CSR)
			if err != nil {
				t.Fatal(err)
			}
			block, _ := pem.Decode(csrPEM)
			if block == nil {
				t.Fatal("missing CSR")
			}
			csr, err := x509.ParseCertificateRequest(block.Bytes)
			if err != nil || csr.CheckSignature() != nil || csr.Subject.CommonName != subject.CommonName || !key.Public().(ed25519.PublicKey).Equal(csr.PublicKey) {
				t.Fatal("CSR changed the existing identity")
			}
			if refreshes == 1 {
				body = `{"code":123,"message":"private detail"}`
			} else {
				encoded, _ := json.Marshal(makeCert(csr.PublicKey, 20*24*time.Hour))
				body = fmt.Sprintf(`{"code":0,"result":{"cert":%s}}`, encoded)
			}
		default:
			t.Fatalf("unexpected request path %q", req.URL.Path)
		}
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}

	if _, err := Renew(context.Background(), client, path, now, false); err == nil || strings.Contains(err.Error(), "private detail") {
		t.Fatalf("expected redacted signing failure, got %v", err)
	}
	afterFailure, err := Load(path)
	if err != nil || afterFailure.Cert != current.Cert || afterFailure.RefreshToken != "refresh-1" {
		t.Fatal("did not preserve current certificate and rotated refresh token")
	}
	updated, err := Renew(context.Background(), client, path, now, false)
	if err != nil || updated.Cert == current.Cert || updated.Key != current.Key || updated.RefreshToken != "refresh-2" {
		t.Fatalf("renewal failed: %v", err)
	}
	if _, err := Renew(context.Background(), client, path, now, false); err != nil || refreshes != 2 {
		t.Fatalf("valid certificate caused an unnecessary refresh: %v", err)
	}
}
