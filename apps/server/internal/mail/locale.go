package mail

import (
	"sort"
	"strconv"
	"strings"
)

// Supported mail locales (users.locale). English is the fallback.
const (
	LocaleEN   = "en"
	LocaleRU   = "ru"
	LocaleES   = "es"
	LocaleZhCN = "zh-CN"
)

// Supported maps a BCP 47 tag ("ru-RU", "zh-Hans", "ES") to a supported locale, "" if none.
func Supported(tag string) string {
	tag = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(tag, "_", "-")))
	lang, _, _ := strings.Cut(tag, "-")
	switch lang {
	case "en":
		return LocaleEN
	case "ru":
		return LocaleRU
	case "es":
		return LocaleES
	case "zh":
		return LocaleZhCN // the only Chinese we have
	}
	return ""
}

// Locale is Supported with the English fallback.
func Locale(tag string) string {
	if l := Supported(tag); l != "" {
		return l
	}
	return LocaleEN
}

// FromAcceptLanguage picks the preferred supported locale of an Accept-Language header,
// "" if none is supported.
func FromAcceptLanguage(h string) string {
	type pref struct {
		tag string
		q   float64
		i   int
	}
	var prefs []pref
	for i, part := range strings.Split(h, ",") {
		if i >= 20 {
			break
		}
		tag, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		q := 1.0
		if v, ok := strings.CutPrefix(strings.TrimSpace(params), "q="); ok {
			f, err := strconv.ParseFloat(v, 64)
			if err != nil {
				continue
			}
			q = f
		}
		if q > 0 && tag != "" && tag != "*" {
			prefs = append(prefs, pref{tag, q, i})
		}
	}
	sort.SliceStable(prefs, func(a, b int) bool { return prefs[a].q > prefs[b].q })
	for _, p := range prefs {
		if l := Supported(p.tag); l != "" {
			return l
		}
	}
	return ""
}
