package pbconv

import (
	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/builtinstickers"
	"github.com/calaba/calaba/server/internal/db/sqlc"
)

// Sticker converts a sticker row (ADR-0030); size is its file's size in bytes.
func Sticker(s sqlc.Sticker, size int64) *v1.Sticker {
	if b := builtinstickers.Sticker(s.ID.String()); b != nil && s.PackID.String() == builtinstickers.PackID() {
		return b
	}
	return &v1.Sticker{
		Id:       s.ID.String(),
		PackId:   s.PackID.String(),
		Emoji:    s.Emoji,
		Url:      "/api/files/" + idp(s.FileID),
		Width:    uint32(max(s.Width, 0)),  //nolint:gosec // 1..512
		Height:   uint32(max(s.Height, 0)), //nolint:gosec // 1..512
		Animated: s.Animated,
		Size:     uint32(min(max(size, 0), 1<<31)), //nolint:gosec // ≤ 1 MB
		Deleted:  s.DeletedAt != nil,
	}
}

// StickerPack converts a pack with its live stickers in order.
func StickerPack(p sqlc.StickerPack, stickers []*v1.Sticker) *v1.StickerPack {
	if stickers == nil {
		stickers = []*v1.Sticker{}
	}
	return &v1.StickerPack{
		Id:             p.ID.String(),
		WorkspaceId:    idp(p.WorkspaceID),
		Name:           p.Name,
		ShortName:      p.ShortName,
		CoverStickerId: idp(p.CoverStickerID),
		Stickers:       stickers,
		CreatedBy:      idp(p.CreatedBy),
		CreatedAt:      ts(p.CreatedAt),
		UpdatedAt:      ts(p.UpdatedAt),
	}
}
