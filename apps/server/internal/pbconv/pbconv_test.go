package pbconv

import (
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestSettingsDefaults(t *testing.T) {
	for name, c := range map[string]struct {
		raw   string
		noise bool
		mode  v1.MicMode
	}{
		"empty row":           {`{}`, true, v1.MicMode_MIC_MODE_VAD},
		"nil":                 {``, true, v1.MicMode_MIC_MODE_VAD},
		"explicit false":      {`{"noiseSuppression":false,"micMode":"MIC_MODE_PUSH_TO_TALK"}`, false, v1.MicMode_MIC_MODE_PUSH_TO_TALK},
		"legacy push to talk": {`{"pushToTalk":true}`, true, v1.MicMode_MIC_MODE_PUSH_TO_TALK},
		"corrupt":             {`not json`, true, v1.MicMode_MIC_MODE_VAD},
	} {
		s := Settings([]byte(c.raw))
		if s.GetNoiseSuppression() != c.noise || s.GetMicMode() != c.mode || s.GetPushToTalk() != (c.mode == v1.MicMode_MIC_MODE_PUSH_TO_TALK) || s.AudioBitrateKbps != nil { //nolint:staticcheck // legacy field
			t.Errorf("%s: %v", name, s)
		}
	}
	// Encode keeps false explicit, so it survives a round trip.
	b, err := EncodeSettings(&v1.UserSettings{NoiseSuppression: false})
	if err != nil {
		t.Fatal(err)
	}
	if s := Settings(b); s.GetNoiseSuppression() || s.GetMicMode() != v1.MicMode_MIC_MODE_VAD {
		t.Fatalf("round trip: %s -> %v", b, s)
	}
	br := uint32(48)
	b, _ = EncodeSettings(&v1.UserSettings{AudioBitrateKbps: &br})
	if Settings(b).GetAudioBitrateKbps() != 48 {
		t.Fatal("bitrate lost")
	}
}
