// Package sui provides a wrapper around the SUI JSON-RPC API.
package sui

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client communicates with a SUI full node's JSON-RPC endpoint.
type Client struct {
	rpcURL     string
	httpClient *http.Client
}

// NewClient creates a new SUI RPC client.
func NewClient(rpcURL string) *Client {
	return &Client{
		rpcURL: rpcURL,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// EventPage is the paginated response from suix_queryEvents.
type EventPage struct {
	Data       []Event `json:"data"`
	NextCursor *string `json:"nextCursor"`
	HasMore    bool    `json:"hasNextPage"`
}

// Event represents a SUI event from the chain.
type Event struct {
	ID struct {
		TxDigest string `json:"txDigest"`
		EventSeq string `json:"eventSeq"`
	} `json:"id"`
	PackageID         string          `json:"packageId"`
	TransactionModule string          `json:"transactionModule"`
	Type              string          `json:"type"`
	ParsedJSON        json.RawMessage `json:"parsedJson"`
	TimestampMs       string          `json:"timestampMs"`
}

// QueryEvents fetches events for a given package from the SUI chain.
func (c *Client) QueryEvents(ctx context.Context, packageID string, cursor *string, limit int) (*EventPage, error) {
	filter := map[string]string{"Package": packageID}

	params := []any{filter, cursor, limit, false}

	resp, err := c.call(ctx, "suix_queryEvents", params)
	if err != nil {
		return nil, fmt.Errorf("query events: %w", err)
	}

	var page EventPage
	if err := json.Unmarshal(resp, &page); err != nil {
		return nil, fmt.Errorf("unmarshal events: %w", err)
	}

	return &page, nil
}

// GetTransaction retrieves transaction details by digest.
func (c *Client) GetTransaction(ctx context.Context, txDigest string) (json.RawMessage, error) {
	params := []any{txDigest, map[string]bool{
		"showInput":          true,
		"showEffects":        true,
		"showEvents":         true,
		"showObjectChanges":  true,
		"showBalanceChanges": true,
	}}

	return c.call(ctx, "sui_getTransactionBlock", params)
}

type rpcRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      int    `json:"id"`
	Method  string `json:"method"`
	Params  []any  `json:"params"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (c *Client) call(ctx context.Context, method string, params []any) (json.RawMessage, error) {
	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  method,
		Params:  params,
	}

	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.rpcURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	httpResp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("http request: %w", err)
	}
	defer httpResp.Body.Close()

	respBody, err := io.ReadAll(httpResp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	var resp rpcResponse
	if err := json.Unmarshal(respBody, &resp); err != nil {
		return nil, fmt.Errorf("unmarshal response: %w", err)
	}

	if resp.Error != nil {
		return nil, fmt.Errorf("rpc error %d: %s", resp.Error.Code, resp.Error.Message)
	}

	return resp.Result, nil
}
