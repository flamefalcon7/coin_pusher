// Package v1 provides the web framework primitives for API version 1.
package v1

import (
	"context"
	"encoding/json"
	"net/http"
)

// Handler is the signature all v1 route handlers must satisfy.
type Handler func(ctx context.Context, w http.ResponseWriter, r *http.Request) error

// Respond converts a Go value to JSON and sends it to the client.
func Respond(w http.ResponseWriter, statusCode int, data any) error {
	if statusCode == http.StatusNoContent {
		w.WriteHeader(statusCode)
		return nil
	}

	jsonData, err := json.Marshal(data)
	if err != nil {
		return err
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	if _, err := w.Write(jsonData); err != nil {
		return err
	}

	return nil
}

// Decode reads the body of an HTTP request looking for a JSON document.
func Decode(r *http.Request, val any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(val); err != nil {
		return NewRequestError(err, http.StatusBadRequest)
	}
	return nil
}
