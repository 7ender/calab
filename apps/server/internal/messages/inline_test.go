package messages

import (
	"strings"
	"testing"

	v1 "github.com/calaba/calaba/server/gen/calaba/v1"
)

func TestInlineKeyboardBounds(t *testing.T) {
	valid := func() *v1.InlineKeyboard {
		return &v1.InlineKeyboard{Rows: []*v1.InlineKeyboardRow{{Buttons: []*v1.InlineButton{{Id: "action", Label: "Подтвердить", Data: "public:v1"}}}}}
	}
	for name, change := range map[string]func(*v1.InlineKeyboard){
		"duplicate button": func(k *v1.InlineKeyboard) { k.Rows[0].Buttons = append(k.Rows[0].Buttons, k.Rows[0].Buttons[0]) },
		"too many rows": func(k *v1.InlineKeyboard) {
			k.Rows = append(k.Rows, k.Rows[0], k.Rows[0], k.Rows[0], k.Rows[0], k.Rows[0])
		},
		"empty row":        func(k *v1.InlineKeyboard) { k.Rows[0].Buttons = nil },
		"too many buttons": func(k *v1.InlineKeyboard) { k.Rows[0].Buttons = make([]*v1.InlineButton, 6) },
		"blank label":      func(k *v1.InlineKeyboard) { k.Rows[0].Buttons[0].Label = " " },
		"long label":       func(k *v1.InlineKeyboard) { k.Rows[0].Buttons[0].Label = strings.Repeat("я", 81) },
		"control label":    func(k *v1.InlineKeyboard) { k.Rows[0].Buttons[0].Label = "approve\nsecret" },
		"long data bytes":  func(k *v1.InlineKeyboard) { k.Rows[0].Buttons[0].Data = strings.Repeat("я", 257) },
		"bad id":           func(k *v1.InlineKeyboard) { k.Rows[0].Buttons[0].Id = "a b" },
		"bad user":         func(k *v1.InlineKeyboard) { k.AllowedUserIds = []string{"actor"} },
		"too many users":   func(k *v1.InlineKeyboard) { k.AllowedUserIds = make([]string, 51) },
	} {
		t.Run(name, func(t *testing.T) {
			k := valid()
			change(k)
			if _, err := encodeKeyboard(k); err == nil {
				t.Fatal("invalid keyboard accepted")
			}
		})
	}
	k := valid()
	k.Rows[0].Buttons[0].Label = strings.Repeat("я", 80)
	k.Rows[0].Buttons[0].Data = strings.Repeat("я", 256)
	if _, err := encodeKeyboard(k); err != nil {
		t.Fatal(err)
	}
	if data, err := encodeKeyboard(&v1.InlineKeyboard{}); err != nil || data != nil {
		t.Fatal("empty keyboard must remove actions")
	}
}
