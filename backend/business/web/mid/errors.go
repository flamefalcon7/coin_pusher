package mid

import (
	"net/http"

	v1 "github.com/flamefalcon/coin-pusher/backend/business/web/v1"
	"go.uber.org/zap"
)

// Errors wraps a v1.Handler and converts returned errors into HTTP responses.
// RequestErrors map to their embedded status; all others become 500.
func Errors(log *zap.SugaredLogger, handler v1.Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := handler(r.Context(), w, r); err != nil {
			var reqErr *v1.RequestError
			if ok := asRequestError(err, &reqErr); ok {
				resp := v1.ErrorResponse{Error: reqErr.Error()}
				if writeErr := v1.Respond(w, reqErr.Status, resp); writeErr != nil {
					log.Errorw("respond error", "error", writeErr)
				}
				return
			}

			log.Errorw("internal error",
				"error", err,
				"correlation_id", GetCorrelationID(r.Context()),
			)

			resp := v1.ErrorResponse{Error: http.StatusText(http.StatusInternalServerError)}
			if writeErr := v1.Respond(w, http.StatusInternalServerError, resp); writeErr != nil {
				log.Errorw("respond error", "error", writeErr)
			}
		}
	}
}

// asRequestError extracts a *RequestError from an error chain.
func asRequestError(err error, target **v1.RequestError) bool {
	// Use type assertion on the error chain.
	for e := err; e != nil; {
		if re, ok := e.(*v1.RequestError); ok {
			*target = re
			return true
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}
