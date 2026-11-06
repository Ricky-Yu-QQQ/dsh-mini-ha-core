package mipsidentity

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const ClientID = 2882303761520251711
const xiaomiAPI = "https://ha.api.io.mi.com"
const CallbackHost = "homeassistant.local:8123"

func RedirectURI(did string) string {
	return "http://" + CallbackHost + "/api/webhook/" + did
}

func NewHTTPClient() *http.Client {
	return &http.Client{
		Timeout:       20 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func api(ctx context.Context, client *http.Client, deviceID string, operation, path, token string, data, result any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	method, endpoint := http.MethodPost, xiaomiAPI+path
	var body io.Reader = bytes.NewReader(payload)
	if token == "" {
		method, body = http.MethodGet, nil
		endpoint += "?" + url.Values{"data": {string(payload)}}.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return fmt.Errorf("%s: invalid request", operation)
	}
	req.Header.Set("User-Agent", "ha_xiaomi_home/v0.5.0 client/"+deviceID)
	if token == "" {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	} else {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer"+token)
		req.Header.Set("X-Client-BizId", "haapi")
		req.Header.Set("X-Client-AppId", strconv.FormatInt(ClientID, 10))
	}
	response, err := client.Do(req)
	if err != nil {
		// Transport errors can include the URL, which carries the one-time code.
		return fmt.Errorf("%s: HTTPS request failed", operation)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", operation, response.StatusCode)
	}
	var envelope struct {
		Code   *int            `json:"code"`
		Result json.RawMessage `json:"result"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&envelope) != nil || envelope.Code == nil {
		return fmt.Errorf("%s: invalid response", operation)
	}
	if *envelope.Code != 0 {
		return fmt.Errorf("%s: Xiaomi error %d", operation, *envelope.Code)
	}
	if json.Unmarshal(envelope.Result, result) != nil {
		return fmt.Errorf("%s: invalid result", operation)
	}
	return nil
}
