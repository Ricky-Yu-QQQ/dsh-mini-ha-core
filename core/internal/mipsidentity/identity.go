package mipsidentity

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

const RenewBefore = 72 * time.Hour

type Identity struct {
	VirtualDID   string `json:"virtualDid"`
	Cert         string `json:"cert"`
	Key          string `json:"key"`
	UID          string `json:"uid,omitempty"`
	DeviceID     string `json:"deviceId,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
}

func (id Identity) certificate() (*x509.Certificate, error) {
	pair, err := tls.X509KeyPair([]byte(id.Cert), []byte(id.Key))
	if err != nil {
		return nil, errors.New("invalid MIPS client certificate or key")
	}
	return x509.ParseCertificate(pair.Certificate[0])
}

func (id Identity) ExpiresAt() (time.Time, error) {
	cert, err := id.certificate()
	if err != nil {
		return time.Time{}, err
	}
	return cert.NotAfter, nil
}

func clientSubject(uid, did string) pkix.Name {
	return pkix.Name{
		Country: []string{"CN"}, Organization: []string{"Mijia Device"},
		CommonName: fmt.Sprintf("mips.%s.%x.2", uid, sha1.Sum([]byte(did))),
	}
}

func encodeKey(key ed25519.PrivateKey) (string, error) {
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return "", err
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), nil
}

func decodeKey(encoded string) (ed25519.PrivateKey, error) {
	block, _ := pem.Decode([]byte(encoded))
	if block != nil {
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if edKey, ok := key.(ed25519.PrivateKey); err == nil && ok {
			return edKey, nil
		}
	}
	return nil, errors.New("invalid MIPS Ed25519 private key")
}

type oauthToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

func exchange(ctx context.Context, client *http.Client, id Identity, grant map[string]any) (oauthToken, error) {
	grant["client_id"] = ClientID
	grant["redirect_uri"] = RedirectURI(id.VirtualDID)
	var token oauthToken
	if err := api(ctx, client, id.DeviceID, "exchange Xiaomi authorization", "/app/v2/ha/oauth/get_token", "", grant, &token); err != nil {
		return oauthToken{}, err
	}
	if token.AccessToken == "" || token.RefreshToken == "" {
		return oauthToken{}, errors.New("Xiaomi did not return complete OAuth credentials")
	}
	return token, nil
}

func accountID(ctx context.Context, client *http.Client, id Identity, accessToken string) (string, error) {
	var homes struct {
		Homes []struct {
			UID json.Number `json:"uid"`
		} `json:"homelist"`
	}
	err := api(ctx, client, id.DeviceID, "get account ID", "/app/v2/homeroom/gethome", accessToken, map[string]any{
		"limit": 150, "fetch_share": false, "fetch_share_dev": false, "plat_form": 0, "app_ver": 9,
	}, &homes)
	if err != nil {
		return "", err
	}
	if len(homes.Homes) == 0 {
		return "", errors.New("get account ID: no owned Xiaomi home")
	}
	uid := homes.Homes[0].UID.String()
	if _, err := strconv.ParseUint(uid, 10, 64); err != nil {
		return "", errors.New("get account ID: invalid owner")
	}
	return uid, nil
}

// Enroll also upgrades an existing certificate without changing its key or virtual DID.
func Enroll(ctx context.Context, client *http.Client, id Identity, code string) (Identity, error) {
	token, err := exchange(ctx, client, id, map[string]any{"code": code, "device_id": id.DeviceID})
	if err != nil {
		return Identity{}, err
	}
	uid, err := accountID(ctx, client, id, token.AccessToken)
	if err != nil {
		return Identity{}, err
	}
	if id.Cert != "" {
		oldCert, err := id.certificate()
		if err != nil {
			return Identity{}, err
		}
		if oldCert.Subject.CommonName != clientSubject(uid, id.VirtualDID).CommonName {
			return Identity{}, errors.New("Xiaomi account does not own the existing MIPS identity")
		}
	} else {
		_, key, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return Identity{}, err
		}
		id.Key, err = encodeKey(key)
		if err != nil {
			return Identity{}, err
		}
	}
	id.UID, id.RefreshToken = uid, token.RefreshToken
	return sign(ctx, client, id, token.AccessToken)
}

func sign(ctx context.Context, client *http.Client, id Identity, accessToken string) (Identity, error) {
	key, err := decodeKey(id.Key)
	if err != nil {
		return Identity{}, err
	}
	subject := clientSubject(id.UID, id.VirtualDID)
	csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: subject}, key)
	if err != nil {
		return Identity{}, err
	}
	csrPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr})
	var result struct {
		Cert string `json:"cert"`
	}
	err = api(ctx, client, id.DeviceID, "sign gateway certificate", "/app/v2/ha/oauth/get_central_crt", accessToken, map[string]string{
		"csr": base64.StdEncoding.EncodeToString(csrPEM),
	}, &result)
	if err != nil {
		return Identity{}, err
	}
	id.Cert = result.Cert
	cert, err := id.certificate()
	if err != nil {
		return Identity{}, err
	}
	now := time.Now()
	if cert.Subject.CommonName != subject.CommonName || now.Before(cert.NotBefore) || !now.Add(RenewBefore).Before(cert.NotAfter) {
		return Identity{}, errors.New("issued certificate has an unexpected identity or validity window")
	}
	return id, nil
}
