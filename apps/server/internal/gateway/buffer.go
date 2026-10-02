package gateway

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/rueidis"

	"github.com/calaba/calaba/server/internal/redisx"
)

// Session buffer in Redis (docs/05, RESUME):
//
//	gw:sess:<gsid>  hash {user, asess, owner, seq, bot, tab}; TTL = resume window, renewed while alive
//	gw:buf:<gsid>   list of entries: 16-byte event id + binary GatewayFrame (DISPATCH with seq)
//	                capped at bufferMax entries, same TTL
//
// Only the owning instance appends. RESUME on another instance first takes ownership
// (see Hub.takeover), then reads the buffer.
const (
	bufferMax    = 1000
	resumeWindow = 5 * time.Minute
)

type entry struct {
	enc            *encEvent // resolved replay attribution; not serialized
	workspace      uuid.UUID
	identityFormat bool
	id             uuid.UUID
	seq            uint64
	frame          []byte        // binary GatewayFrame
	flush          chan struct{} // writer barrier (not stored)
}

func (e entry) encode() []byte {
	b := make([]byte, 0, 24+len(e.frame))
	b = append(b, e.id[:]...)
	b = strconv.AppendUint(b, e.seq, 10)
	b = append(b, ':')
	b = append(b, 'I', '2', ':')
	b = append(b, e.workspace[:]...)
	return append(b, e.frame...)
}

func decodeEntry(b []byte) (entry, error) {
	if len(b) < 18 {
		return entry{}, errors.New("gateway: short buffer entry")
	}
	id, _ := uuid.FromBytes(b[:16])
	rest := b[16:]
	i := 0
	for i < len(rest) && rest[i] != ':' {
		i++
	}
	if i == len(rest) {
		return entry{}, errors.New("gateway: malformed buffer entry")
	}
	seq, err := strconv.ParseUint(string(rest[:i]), 10, 64)
	if err != nil {
		return entry{}, err
	}
	payload := rest[i+1:]
	e := entry{id: id, seq: seq, frame: payload}
	if len(payload) >= 19 && string(payload[:3]) == "I2:" {
		e.identityFormat = true
		e.workspace, _ = uuid.FromBytes(payload[3:19])
		e.frame = payload[19:]
	}
	return e, nil
}

// since returns the entries after seq. ok=false when the buffer no longer covers seq+1
// (trimmed or expired): the client must IDENTIFY again.
func since(entries []entry, seq, last uint64) (out []entry, ok bool) {
	if seq > last {
		return nil, false // client claims a seq we never sent
	}
	if seq == last {
		return nil, true
	}
	if len(entries) == 0 || entries[0].seq > seq+1 {
		return nil, false
	}
	for _, e := range entries {
		if e.seq > seq {
			out = append(out, e)
		}
	}
	return out, true
}

type sessMeta struct {
	user, asess uuid.UUID
	owner       string
	seq         uint64
	bot         bool
	tab         string // Identify.tab_id ("" = the device itself), see tabs.go
}

type bufferStore struct{ c rueidis.Client }

func sessKey(g uuid.UUID) string { return redisx.Key("gw:sess:" + g.String()) }
func bufKey(g uuid.UUID) string  { return redisx.Key("gw:buf:" + g.String()) }

func (b bufferStore) create(ctx context.Context, gsid, user, asess uuid.UUID, owner string, bot bool, tab string) error {
	isBot := "0"
	if bot {
		isBot = "1"
	}
	res := b.c.DoMulti(ctx,
		b.c.B().Hset().Key(sessKey(gsid)).FieldValue().FieldValue("user", user.String()).
			FieldValue("asess", asess.String()).FieldValue("owner", owner).FieldValue("seq", "0").FieldValue("bot", isBot).FieldValue("tab", tab).Build(),
		b.c.B().Expire().Key(sessKey(gsid)).Seconds(int64(resumeWindow.Seconds())).Build())
	return res[0].Error()
}

func (b bufferStore) meta(ctx context.Context, gsid uuid.UUID) (sessMeta, bool, error) {
	m, err := b.c.Do(ctx, b.c.B().Hgetall().Key(sessKey(gsid)).Build()).AsStrMap()
	if err != nil {
		return sessMeta{}, false, err
	}
	if len(m) == 0 {
		return sessMeta{}, false, nil
	}
	u, err1 := uuid.Parse(m["user"])
	a, err2 := uuid.Parse(m["asess"])
	seq, err3 := strconv.ParseUint(m["seq"], 10, 64)
	if err1 != nil || err2 != nil || err3 != nil {
		return sessMeta{}, false, nil
	}
	return sessMeta{user: u, asess: a, owner: m["owner"], seq: seq, bot: m["bot"] == "1", tab: validTabID(m["tab"])}, true, nil
}

func (b bufferStore) setOwner(ctx context.Context, gsid uuid.UUID, owner string) error {
	return b.c.Do(ctx, b.c.B().Hset().Key(sessKey(gsid)).FieldValue().FieldValue("owner", owner).Build()).Error()
}

// append writes entries in order (one pipeline) and records the last seq.
func (b bufferStore) append(ctx context.Context, gsid uuid.UUID, es []entry) error {
	if len(es) == 0 {
		return nil
	}
	push := b.c.B().Rpush().Key(bufKey(gsid)).Element(string(es[0].encode()))
	for _, e := range es[1:] {
		push = push.Element(string(e.encode()))
	}
	ttl := int64(resumeWindow.Seconds())
	res := b.c.DoMulti(ctx,
		push.Build(),
		b.c.B().Ltrim().Key(bufKey(gsid)).Start(-bufferMax).Stop(-1).Build(),
		b.c.B().Hset().Key(sessKey(gsid)).FieldValue().FieldValue("seq", strconv.FormatUint(es[len(es)-1].seq, 10)).Build(),
		b.c.B().Expire().Key(bufKey(gsid)).Seconds(ttl).Build(),
		b.c.B().Expire().Key(sessKey(gsid)).Seconds(ttl).Build())
	for _, r := range res {
		if err := r.Error(); err != nil {
			return err
		}
	}
	return nil
}

func (b bufferStore) touch(ctx context.Context, gsid uuid.UUID) {
	ttl := int64(resumeWindow.Seconds())
	b.c.DoMulti(ctx,
		b.c.B().Expire().Key(bufKey(gsid)).Seconds(ttl).Build(),
		b.c.B().Expire().Key(sessKey(gsid)).Seconds(ttl).Build())
}

func (b bufferStore) entries(ctx context.Context, gsid uuid.UUID) ([]entry, error) {
	raw, err := b.c.Do(ctx, b.c.B().Lrange().Key(bufKey(gsid)).Start(0).Stop(-1).Build()).AsStrSlice()
	if err != nil {
		return nil, err
	}
	out := make([]entry, 0, len(raw))
	for _, r := range raw {
		e, err := decodeEntry([]byte(r))
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

func (b bufferStore) drop(ctx context.Context, gsid uuid.UUID) {
	b.c.Do(ctx, b.c.B().Del().Key(sessKey(gsid), bufKey(gsid)).Build())
}
