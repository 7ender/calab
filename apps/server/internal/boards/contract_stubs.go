package boards

import (
	"net/http"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/httpx"
)

// Boards 2.0 routes (ADR-0058), registered by the contract stage so the route tables
// (identity census, bot routes) are complete from the start. Each stage replaces its lines
// with the real handler; the file goes away with the last one.
var contractStubRoutes = []string{
	// §1 board categories (stage 1)
	"GET /api/workspaces/{id}/board-categories",
	"POST /api/workspaces/{id}/board-categories",
	"PATCH /api/board-categories/{id}",
	"DELETE /api/board-categories/{id}",
	"PUT /api/workspaces/{id}/boards/order",
	// §4 board webhook (stage 3)
	"GET /api/boards/{id}/webhook",
	"PUT /api/boards/{id}/webhook",
	"DELETE /api/boards/{id}/webhook",
	"POST /api/boards/{id}/webhook/ping",
}

func notImplemented(http.ResponseWriter, *http.Request) error {
	return httpx.Coded(http.StatusNotImplemented, v1.ErrorCode_ERROR_CODE_UNAVAILABLE, "not implemented yet (ADR-0058)")
}
