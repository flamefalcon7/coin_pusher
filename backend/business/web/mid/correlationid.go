package mid

import (
	"net/http"

	"github.com/google/uuid"
)

// CorrelationID reads X-Correlation-ID from the request header or generates
// a new UUID, then stores it in the context and response header.
func CorrelationID() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id := r.Header.Get("X-Correlation-ID")
			if id == "" {
				id = uuid.NewString()
			}

			ctx := SetCorrelationID(r.Context(), id)
			w.Header().Set("X-Correlation-ID", id)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
