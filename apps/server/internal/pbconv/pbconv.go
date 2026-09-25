// Package pbconv converts DB rows (sqlc) to wire messages (calaba.v1) and maps enums
// between their DB text form and proto. Keep all such mapping here.
package pbconv

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
	"github.com/calaba/calaba/server/internal/db/sqlc"
	"github.com/calaba/calaba/server/internal/perm"
)

func ts(t time.Time) *timestamppb.Timestamp { return timestamppb.New(t) }

func tsp(t *time.Time) *timestamppb.Timestamp {
	if t == nil {
		return nil
	}
	return timestamppb.New(*t)
}

func idp(id *uuid.UUID) string {
	if id == nil {
		return ""
	}
	return id.String()
}

// ---- enums ----

var presetToDB = map[v1.ScreenSharePreset]string{
	v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ECONOMY:  "economy",
	v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H720:     "h720",
	v1.ScreenSharePreset_SCREEN_SHARE_PRESET_H1080:    "h1080",
	v1.ScreenSharePreset_SCREEN_SHARE_PRESET_ORIGINAL: "original",
}

// PresetToDB maps a concrete preset to its DB text; ok=false for UNSPECIFIED/unknown.
func PresetToDB(p v1.ScreenSharePreset) (string, bool) {
	s, ok := presetToDB[p]
	return s, ok
}

// PresetFromDB maps DB text to the enum.
func PresetFromDB(s string) v1.ScreenSharePreset {
	for k, v := range presetToDB {
		if v == s {
			return k
		}
	}
	return v1.ScreenSharePreset_SCREEN_SHARE_PRESET_UNSPECIFIED
}

// VisibilityToDB maps the enum; UNSPECIFIED means private.
func VisibilityToDB(v v1.WorkspaceVisibility) (string, bool) {
	switch v {
	case v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_UNSPECIFIED, v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE:
		return "private", true
	case v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_OPEN:
		return "open", true
	}
	return "", false
}

func visibilityFromDB(s string) v1.WorkspaceVisibility {
	if s == "open" {
		return v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_OPEN
	}
	return v1.WorkspaceVisibility_WORKSPACE_VISIBILITY_PRIVATE
}

// RoomTypeToDB maps the enum; ok=false for UNSPECIFIED/unknown.
func RoomTypeToDB(t v1.RoomType) (string, bool) {
	switch t {
	case v1.RoomType_ROOM_TYPE_VOICE:
		return "voice", true
	case v1.RoomType_ROOM_TYPE_TEXT:
		return "text", true
	}
	return "", false
}

func roomTypeFromDB(s string) v1.RoomType {
	if s == "voice" {
		return v1.RoomType_ROOM_TYPE_VOICE
	}
	return v1.RoomType_ROOM_TYPE_TEXT
}

// TargetTypeToDB maps the enum; ok=false for UNSPECIFIED/unknown.
func TargetTypeToDB(t v1.PermissionTargetType) (string, bool) {
	switch t {
	case v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE:
		return "role", true
	case v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER:
		return "user", true
	}
	return "", false
}

func targetTypeFromDB(s string) v1.PermissionTargetType {
	if s == "role" {
		return v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE
	}
	return v1.PermissionTargetType_PERMISSION_TARGET_TYPE_USER
}

// ---- users / sessions ----

// User is the public profile.
func User(u sqlc.User) *v1.User {
	return &v1.User{
		Id:           u.ID.String(),
		DisplayName:  u.DisplayName,
		AvatarFileId: idp(u.AvatarFileID),
		StatusText:   u.StatusText,
		CreatedAt:    ts(u.CreatedAt),
	}
}

// Settings decodes users.settings (protojson). Fields missing from the stored JSON (rows
// created before a field existed) get their defaults; corrupt data yields defaults.
func Settings(raw []byte) *v1.UserSettings {
	s := &v1.UserSettings{}
	var present map[string]json.RawMessage
	if len(raw) > 0 && json.Unmarshal(raw, &present) == nil {
		_ = protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(raw, s)
	}
	if _, ok := present["noiseSuppression"]; !ok {
		s.NoiseSuppression = true
	}
	return NormalizeSettings(s)
}

// NormalizeSettings resolves mic_mode (UNSPECIFIED → from the legacy push_to_talk flag,
// else VAD) and keeps the deprecated push_to_talk flag in sync with it.
func NormalizeSettings(s *v1.UserSettings) *v1.UserSettings {
	if s.GetMicMode() == v1.MicMode_MIC_MODE_UNSPECIFIED {
		s.MicMode = v1.MicMode_MIC_MODE_VAD
		if s.GetPushToTalk() { //nolint:staticcheck // legacy field
			s.MicMode = v1.MicMode_MIC_MODE_PUSH_TO_TALK
		}
	}
	s.PushToTalk = s.GetMicMode() == v1.MicMode_MIC_MODE_PUSH_TO_TALK //nolint:staticcheck // legacy field
	return s
}

// EncodeSettings stores settings with every field explicit, so a stored false stays false.
func EncodeSettings(s *v1.UserSettings) ([]byte, error) {
	return protojson.MarshalOptions{EmitDefaultValues: true}.Marshal(NormalizeSettings(s))
}

// DefaultSettings are the settings of a new user.
func DefaultSettings() *v1.UserSettings {
	return &v1.UserSettings{NoiseSuppression: true, MicMode: v1.MicMode_MIC_MODE_VAD}
}

// Me is the authenticated user's own view.
func Me(u sqlc.User) *v1.Me {
	return &v1.Me{User: User(u), Email: u.Email, Settings: Settings(u.Settings)}
}

// Session converts a session; current marks the caller's own session.
func Session(s sqlc.Session, current uuid.UUID) *v1.Session {
	return &v1.Session{
		Id:         s.ID.String(),
		DeviceName: s.DeviceName,
		Ip:         s.Ip,
		UserAgent:  s.UserAgent,
		CreatedAt:  ts(s.CreatedAt),
		LastSeenAt: ts(s.LastSeenAt),
		ExpiresAt:  ts(s.ExpiresAt),
		Current:    s.ID == current,
	}
}

// ---- workspaces ----

// WorkspaceDefaults returns the workspace media defaults.
func WorkspaceDefaults(w sqlc.Workspace) *v1.RoomMediaSettings {
	return &v1.RoomMediaSettings{
		AudioBitrateKbps: uint32(w.DefaultAudioBitrateKbps), //nolint:gosec // DB CHECK bounds it
		MaxStreamPreset:  PresetFromDB(w.DefaultMaxStreamPreset),
		MaxStreams:       uint32(w.DefaultMaxStreams), //nolint:gosec // DB CHECK bounds it
	}
}

// Workspace converts a workspace row.
func Workspace(w sqlc.Workspace) *v1.Workspace {
	return &v1.Workspace{
		Id:                w.ID.String(),
		Slug:              w.Slug,
		Name:              w.Name,
		IconFileId:        idp(w.IconFileID),
		Visibility:        visibilityFromDB(w.Visibility),
		OwnerId:           w.OwnerID.String(),
		CreatedAt:         ts(w.CreatedAt),
		MediaDefaults:     WorkspaceDefaults(w),
		StorageQuotaBytes: uint64(max(w.StorageQuotaBytes, 0)),
		StorageUsedBytes:  uint64(max(w.StorageUsedBytes, 0)),
	}
}

// Member converts a membership row with its user.
func Member(m sqlc.WorkspaceMember, u sqlc.User) *v1.WorkspaceMember {
	return &v1.WorkspaceMember{
		WorkspaceId: m.WorkspaceID.String(),
		User:        User(u),
		Role:        perm.Role(m.Role).Proto(),
		Nickname:    m.Nickname,
		JoinedAt:    ts(m.JoinedAt),
	}
}

// Invite converts an invite row.
func Invite(i sqlc.WorkspaceInvite) *v1.Invite {
	return &v1.Invite{
		Id:          i.ID.String(),
		WorkspaceId: i.WorkspaceID.String(),
		Code:        i.Code,
		CreatedBy:   i.CreatedBy.String(),
		MaxUses:     uint32(max(i.MaxUses, 0)),
		Uses:        uint32(max(i.Uses, 0)),
		ExpiresAt:   tsp(i.ExpiresAt),
		CreatedAt:   ts(i.CreatedAt),
	}
}

// ---- rooms ----

// MediaOverride returns the raw per-room override.
func MediaOverride(r sqlc.Room) *v1.RoomMediaOverride {
	o := &v1.RoomMediaOverride{}
	if r.AudioBitrateKbps != nil {
		v := uint32(*r.AudioBitrateKbps) //nolint:gosec // DB CHECK bounds it
		o.AudioBitrateKbps = &v
	}
	if r.MaxStreamPreset != nil {
		v := PresetFromDB(*r.MaxStreamPreset)
		o.MaxStreamPreset = &v
	}
	if r.MaxStreams != nil {
		v := uint32(*r.MaxStreams) //nolint:gosec // DB CHECK bounds it
		o.MaxStreams = &v
	}
	return o
}

// EffectiveMedia merges the room override over the workspace defaults.
func EffectiveMedia(r sqlc.Room, defaults *v1.RoomMediaSettings) *v1.RoomMediaSettings {
	m := &v1.RoomMediaSettings{
		AudioBitrateKbps: defaults.GetAudioBitrateKbps(),
		MaxStreamPreset:  defaults.GetMaxStreamPreset(),
		MaxStreams:       defaults.GetMaxStreams(),
	}
	o := MediaOverride(r)
	if o.AudioBitrateKbps != nil {
		m.AudioBitrateKbps = *o.AudioBitrateKbps
	}
	if o.MaxStreamPreset != nil {
		m.MaxStreamPreset = *o.MaxStreamPreset
	}
	if o.MaxStreams != nil {
		m.MaxStreams = *o.MaxStreams
	}
	return m
}

// Override converts a room_permissions row.
func Override(p sqlc.RoomPermission) *v1.RoomPermissionOverride {
	return &v1.RoomPermissionOverride{
		TargetType: targetTypeFromDB(p.TargetType),
		TargetId:   p.TargetID,
		Allow:      uint64(p.Allow), //nolint:gosec // bit mask round-trip
		Deny:       uint64(p.Deny),  //nolint:gosec // bit mask round-trip
	}
}

// OverrideTargets converts rows for perm.ComputeIn.
func OverrideTargets(rows []sqlc.RoomPermission) []perm.OverrideTarget {
	out := make([]perm.OverrideTarget, len(rows))
	for i, p := range rows {
		out[i] = perm.OverrideTarget{
			TargetType: p.TargetType,
			TargetID:   p.TargetID,
			Override:   perm.Override{Allow: perm.Bits(uint64(p.Allow)), Deny: perm.Bits(uint64(p.Deny))}, //nolint:gosec // bit mask
		}
	}
	return out
}

// Room builds the wire room with effective media settings and its overrides.
func Room(r sqlc.Room, defaults *v1.RoomMediaSettings, overrides []sqlc.RoomPermission) *v1.Room {
	ovs := make([]*v1.RoomPermissionOverride, len(overrides))
	for i, p := range overrides {
		ovs[i] = Override(p)
	}
	return &v1.Room{
		Id:                  r.ID.String(),
		WorkspaceId:         r.WorkspaceID.String(),
		Type:                roomTypeFromDB(r.Type),
		Name:                r.Name,
		Topic:               r.Topic,
		Position:            r.Position,
		IsPrivate:           r.IsPrivate,
		Media:               EffectiveMedia(r, defaults),
		MediaOverride:       MediaOverride(r),
		PermissionOverrides: ovs,
		CreatedAt:           ts(r.CreatedAt),
	}
}

// ---- files / messages ----

// IsImage reports whether a stored mime type gets a thumbnail and inline display.
func IsImage(mime string) bool {
	switch mime {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	}
	return false
}

// File converts a file row; URLs are API paths.
func File(f sqlc.File) *v1.FileMeta {
	m := &v1.FileMeta{
		Id:          f.ID.String(),
		WorkspaceId: idp(f.WorkspaceID),
		UploaderId:  f.UploaderID.String(),
		Name:        f.Name,
		Mime:        f.Mime,
		Size:        uint64(max(f.Size, 0)),
		Sha256:      f.Sha256,
		Url:         "/api/files/" + f.ID.String(),
		CreatedAt:   ts(f.CreatedAt),
	}
	if f.Width != nil && f.Height != nil {
		m.Width, m.Height = uint32(max(*f.Width, 0)), uint32(max(*f.Height, 0))
	}
	if f.ThumbnailKey != nil {
		m.ThumbnailUrl = m.Url + "/thumbnail"
	}
	return m
}

// Message converts a message row with its attachments (in order).
func Message(m sqlc.Message, files []sqlc.File) *v1.Message {
	out := &v1.Message{
		Id:          m.ID.String(),
		RoomId:      m.RoomID.String(),
		AuthorId:    m.AuthorID.String(),
		Content:     m.Content,
		ReplyToId:   idp(m.ReplyToID),
		CreatedAt:   ts(m.CreatedAt),
		EditedAt:    tsp(m.EditedAt),
		Attachments: make([]*v1.FileMeta, len(files)),
	}
	if m.Nonce != nil {
		out.Nonce = *m.Nonce
	}
	for i, f := range files {
		out.Attachments[i] = File(f)
	}
	return out
}

// ProtoOverrideTargets converts wire overrides for perm.ComputeIn.
func ProtoOverrideTargets(ovs []*v1.RoomPermissionOverride) []perm.OverrideTarget {
	out := make([]perm.OverrideTarget, 0, len(ovs))
	for _, o := range ovs {
		tt := "user"
		if o.GetTargetType() == v1.PermissionTargetType_PERMISSION_TARGET_TYPE_ROLE {
			tt = "role"
		}
		out = append(out, perm.OverrideTarget{TargetType: tt, TargetID: o.GetTargetId(),
			Override: perm.Override{Allow: perm.Bits(o.GetAllow()), Deny: perm.Bits(o.GetDeny())}})
	}
	return out
}
