package users

import "testing"

func TestValidateTimezone(t *testing.T) {
	for tz, ok := range map[string]bool{
		"Europe/Moscow": true, "America/Argentina/Buenos_Aires": true, "UTC": true, "Asia/Kolkata": true,
		"Local": false, "Mars/Olympus": false, "../../etc/passwd": false, "/etc/localtime": false,
		"Europe/Moscow ": false, "europe/moscow": false,
	} {
		if err := ValidateTimezone(tz); (err == nil) != ok {
			t.Errorf("%q: err %v, want ok=%v", tz, err, ok)
		}
	}
}
