// Package plans resolves the plan and effective limits of a workspace (ADR-0024) and serves
// the superadmin API. Limits are enforced by the callers (rtc: room members, stream / camera
// quality, streams per room; files: storage) for everyone in the workspace, independent of
// roles.
package plans

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

// Limits are effective workspace limits; 0 / UNSPECIFIED = no limit.
type Limits struct {
	RoomMembers     uint32
	StreamMaxPreset v1.ScreenSharePreset
	StreamMaxFPS    uint32
	CameraMaxPreset v1.ScreenSharePreset
	CameraMaxFPS    uint32
	StreamsPerRoom  uint32
	StorageMB       uint64
	Members         uint32
	StickerPacks    uint32 // live sticker packs of the workspace (ADR-0030)
	Stickers        uint32 // live stickers over all its packs
}

// Built-in defaults; PLAN_FREE_LIMITS / PLAN_TEAM_LIMITS override them key by key.
var (
	// DefaultFree: 5 in a room, video up to 720p / 15 fps, one stream per room, 1 GiB of files,
	// 5 sticker packs with 200 stickers in all.
	DefaultFree = Limits{
		RoomMembers:     5,
		StreamMaxPreset: v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720, StreamMaxFPS: 15,
		CameraMaxPreset: v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720, CameraMaxFPS: 15,
		StreamsPerRoom: 1, StorageMB: 1024, StickerPacks: 5, Stickers: 200,
	}
	// DefaultTeam: 50 in a room, video and storage not limited by the plan (the workspace
	// storage quota still applies).
	DefaultTeam = Limits{RoomMembers: 50}
)

// Upper bounds of every limit (validation of env and admin input).
const (
	maxRoomMembers    = 1000
	maxFPS            = 120
	maxStreamsPerRoom = 100
	maxStorageMB      = 100 << 20 // 100 TiB
	maxMembers        = 1_000_000
	maxStickerPacks   = 10_000
	maxStickers       = 1_000_000
)

var presetNames = map[string]v1.ScreenSharePreset{
	"":         v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED,
	"economy":  v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ECONOMY,
	"h720":     v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720,
	"h1080":    v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080,
	"original": v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL,
}

func presetName(p v1.ScreenSharePreset) string {
	for k, v := range presetNames {
		if v == p {
			return k
		}
	}
	return ""
}

// limitsJSON is the JSON form of Limits (env and workspace_plans.limits). Presets are
// "economy" | "h720" | "h1080" | "original" | "" (no limit); numbers 0 = no limit.
type limitsJSON struct {
	RoomMembers     *uint32 `json:"room_members,omitempty"`
	StreamMaxPreset *string `json:"stream_max_preset,omitempty"`
	StreamMaxFPS    *uint32 `json:"stream_max_fps,omitempty"`
	CameraMaxPreset *string `json:"camera_max_preset,omitempty"`
	CameraMaxFPS    *uint32 `json:"camera_max_fps,omitempty"`
	StreamsPerRoom  *uint32 `json:"streams_per_room,omitempty"`
	StorageMB       *uint64 `json:"storage_mb,omitempty"`
	Members         *uint32 `json:"members,omitempty"`
	StickerPacks    *uint32 `json:"sticker_packs,omitempty"`
	Stickers        *uint32 `json:"stickers,omitempty"`
}

// ParseLimits applies a JSON object over base: keys present replace the base value, absent
// keys keep it. Empty input returns base. The result is validated.
func ParseLimits(raw string, base Limits) (Limits, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return base, nil
	}
	var j limitsJSON
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&j); err != nil {
		return Limits{}, fmt.Errorf("plan limits: %w", err)
	}
	if dec.More() {
		return Limits{}, errors.New("plan limits: trailing data after the JSON object")
	}
	l := base
	setU32 := func(dst *uint32, v *uint32) {
		if v != nil {
			*dst = *v
		}
	}
	setU32(&l.RoomMembers, j.RoomMembers)
	setU32(&l.StreamMaxFPS, j.StreamMaxFPS)
	setU32(&l.CameraMaxFPS, j.CameraMaxFPS)
	setU32(&l.StreamsPerRoom, j.StreamsPerRoom)
	setU32(&l.Members, j.Members)
	setU32(&l.StickerPacks, j.StickerPacks)
	setU32(&l.Stickers, j.Stickers)
	if j.StorageMB != nil {
		l.StorageMB = *j.StorageMB
	}
	for _, p := range []struct {
		dst  *v1.ScreenSharePreset
		v    *string
		name string
	}{{&l.StreamMaxPreset, j.StreamMaxPreset, "stream_max_preset"}, {&l.CameraMaxPreset, j.CameraMaxPreset, "camera_max_preset"}} {
		if p.v == nil {
			continue
		}
		v, ok := presetNames[strings.ToLower(strings.TrimSpace(*p.v))]
		if !ok {
			return Limits{}, fmt.Errorf("plan limits: %s must be economy, h720, h1080, original or empty, got %q", p.name, *p.v)
		}
		*p.dst = v
	}
	if err := l.Validate(); err != nil {
		return Limits{}, err
	}
	return l, nil
}

// MarshalJSON returns the full JSON form (every key present), as stored in the database.
func (l Limits) MarshalJSON() ([]byte, error) {
	sp, cp := presetName(l.StreamMaxPreset), presetName(l.CameraMaxPreset)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	err := enc.Encode(limitsJSON{
		RoomMembers: &l.RoomMembers, StreamMaxPreset: &sp, StreamMaxFPS: &l.StreamMaxFPS,
		CameraMaxPreset: &cp, CameraMaxFPS: &l.CameraMaxFPS, StreamsPerRoom: &l.StreamsPerRoom,
		StorageMB: &l.StorageMB, Members: &l.Members, StickerPacks: &l.StickerPacks, Stickers: &l.Stickers,
	})
	return bytes.TrimSpace(buf.Bytes()), err
}

// Validate checks the bounds of every limit.
func (l Limits) Validate() error {
	var errs []error
	check := func(ok bool, field string, bound uint64) {
		if !ok {
			errs = append(errs, fmt.Errorf("plan limits: %s must be ≤ %d", field, bound))
		}
	}
	check(l.RoomMembers <= maxRoomMembers, "room_members", maxRoomMembers)
	check(l.StreamMaxFPS <= maxFPS, "stream_max_fps", maxFPS)
	check(l.CameraMaxFPS <= maxFPS, "camera_max_fps", maxFPS)
	check(l.StreamsPerRoom <= maxStreamsPerRoom, "streams_per_room", maxStreamsPerRoom)
	check(l.StorageMB <= maxStorageMB, "storage_mb", maxStorageMB)
	check(l.Members <= maxMembers, "members", maxMembers)
	check(l.StickerPacks <= maxStickerPacks, "sticker_packs", maxStickerPacks)
	check(l.Stickers <= maxStickers, "stickers", maxStickers)
	for name, p := range map[string]v1.ScreenSharePreset{"stream_max_preset": l.StreamMaxPreset, "camera_max_preset": l.CameraMaxPreset} {
		if p < v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED || p > v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL {
			errs = append(errs, fmt.Errorf("plan limits: invalid %s", name))
		}
	}
	return errors.Join(errs...)
}

// Proto converts the limits to the wire message.
func (l Limits) Proto() *v1.PlanLimits {
	return &v1.PlanLimits{
		RoomMembers: l.RoomMembers, StreamMaxPreset: l.StreamMaxPreset, StreamMaxFps: l.StreamMaxFPS,
		CameraMaxPreset: l.CameraMaxPreset, CameraMaxFps: l.CameraMaxFPS, StreamsPerRoom: l.StreamsPerRoom,
		StorageMb: l.StorageMB, Members: l.Members, StickerPacks: l.StickerPacks, Stickers: l.Stickers,
	}
}

// FromProto converts the wire message (nil = no limits).
func FromProto(p *v1.PlanLimits) Limits {
	return Limits{
		RoomMembers: p.GetRoomMembers(), StreamMaxPreset: p.GetStreamMaxPreset(), StreamMaxFPS: p.GetStreamMaxFps(),
		CameraMaxPreset: p.GetCameraMaxPreset(), CameraMaxFPS: p.GetCameraMaxFps(), StreamsPerRoom: p.GetStreamsPerRoom(),
		StorageMB: p.GetStorageMb(), Members: p.GetMembers(), StickerPacks: p.GetStickerPacks(), Stickers: p.GetStickers(),
	}
}

// StorageBytes is the plan's storage limit in bytes; ok=false when unlimited.
func (l Limits) StorageBytes() (int64, bool) {
	if l.StorageMB == 0 {
		return 0, false
	}
	return int64(l.StorageMB) << 20, true //nolint:gosec // bounded by maxStorageMB
}

// ---- media caps (used by rtc) ----

// presetFPS is the native frame rate of a screen share preset (docs/02-media.md).
func presetFPS(p v1.ScreenSharePreset) uint32 {
	switch p {
	case v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ECONOMY:
		return 5
	case v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL:
		return 30
	}
	return 15
}

// CapPreset lowers p to limit (UNSPECIFIED limit = none). p must be concrete.
func CapPreset(p, limit v1.ScreenSharePreset) v1.ScreenSharePreset {
	if limit != v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED && p > limit {
		return limit
	}
	return p
}

func minNonZero(vals ...uint32) uint32 {
	out := uint32(0)
	for _, v := range vals {
		if v != 0 && (out == 0 || v < out) {
			out = v
		}
	}
	return out
}

// StreamFPS returns the frame rate granted to a screen share of the (already capped) preset:
// min(wanted, the preset's own, the plan cap); wanted 0 = the preset's own.
func (l Limits) StreamFPS(preset v1.ScreenSharePreset, wanted uint32) uint32 {
	return minNonZero(wanted, presetFPS(preset), l.StreamMaxFPS)
}

// Camera returns the webcam quality granted for the wanted one: min(wanted, plan cap), where
// UNSPECIFIED / 0 wanted means "the best allowed" (the plan cap, or none).
func (l Limits) Camera(wanted v1.ScreenSharePreset, wantedFPS uint32) (v1.ScreenSharePreset, uint32) {
	p := wanted
	if p == v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED || p > v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL {
		p = l.CameraMaxPreset
	} else {
		p = CapPreset(p, l.CameraMaxPreset)
	}
	return p, minNonZero(wantedFPS, l.CameraMaxFPS)
}

// CapMedia returns room media settings with the plan's caps applied (max_stream_preset,
// max_streams). m is not modified.
func (l Limits) CapMedia(m *v1.RoomMediaSettings) *v1.RoomMediaSettings {
	out := &v1.RoomMediaSettings{
		AudioBitrateKbps: m.GetAudioBitrateKbps(), MaxStreamPreset: m.GetMaxStreamPreset(),
		MaxStreams: m.GetMaxStreams(), CameraLimit: m.GetCameraLimit(),
	}
	if out.MaxStreamPreset == v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED {
		out.MaxStreamPreset = l.StreamMaxPreset
	} else {
		out.MaxStreamPreset = CapPreset(out.MaxStreamPreset, l.StreamMaxPreset)
	}
	if l.StreamsPerRoom > 0 && out.MaxStreams > l.StreamsPerRoom {
		out.MaxStreams = l.StreamsPerRoom
	}
	return out
}
