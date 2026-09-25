package unfurl

import (
	"io"
	"net/url"
	"strings"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

// Card is the parsed preview (image URLs still point to the origin site).
type Card struct {
	URL, Title, Description, SiteName, Image, Favicon string
}

// Parse extracts OpenGraph / Twitter / HTML metadata from the document head. body is
// decoded according to contentType (and <meta charset>), base resolves relative URLs.
func Parse(body io.Reader, contentType string, base *url.URL) Card {
	r, err := charset.NewReader(body, contentType)
	if err != nil {
		r = body
	}
	meta := map[string]string{}
	var title, icon string
	z := html.NewTokenizer(r)
	inTitle := false
	for {
		tt := z.Next()
		switch tt {
		case html.ErrorToken:
			return build(meta, title, icon, base)
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			tag := string(name)
			if tag == "body" {
				return build(meta, title, icon, base)
			}
			attrs := map[string]string{}
			for hasAttr {
				var k, v []byte
				k, v, hasAttr = z.TagAttr()
				attrs[string(k)] = string(v)
			}
			switch tag {
			case "title":
				inTitle = true
			case "meta":
				key := strings.ToLower(attrs["property"])
				if key == "" {
					key = strings.ToLower(attrs["name"])
				}
				if key != "" && attrs["content"] != "" {
					if _, seen := meta[key]; !seen {
						meta[key] = attrs["content"]
					}
				}
			case "link":
				rel := strings.ToLower(attrs["rel"])
				if icon == "" && attrs["href"] != "" && (rel == "icon" || rel == "shortcut icon" || rel == "apple-touch-icon") {
					icon = attrs["href"]
				}
			}
		case html.TextToken:
			if inTitle && title == "" {
				title = strings.TrimSpace(string(z.Text()))
			}
		case html.EndTagToken:
			name, _ := z.TagName()
			if string(name) == "title" {
				inTitle = false
			}
			if string(name) == "head" {
				return build(meta, title, icon, base)
			}
		}
	}
}

func first(m map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(m[k]); v != "" {
			return v
		}
	}
	return ""
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

// abs resolves ref against base; only http(s) results are kept.
func abs(base *url.URL, ref string) string {
	if ref == "" {
		return ""
	}
	u, err := base.Parse(strings.TrimSpace(ref))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	return u.String()
}

func build(meta map[string]string, title, icon string, base *url.URL) Card {
	c := Card{
		URL:         base.String(),
		Title:       clip(first(meta, "og:title", "twitter:title"), 300),
		Description: clip(first(meta, "og:description", "twitter:description", "description"), 1000),
		SiteName:    clip(first(meta, "og:site_name", "application-name"), 100),
		Image:       abs(base, first(meta, "og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src")),
	}
	if c.Title == "" {
		c.Title = clip(title, 300)
	}
	if c.SiteName == "" {
		c.SiteName = strings.TrimPrefix(base.Hostname(), "www.")
	}
	if u := abs(base, first(meta, "og:url")); u != "" {
		if pu, err := url.Parse(u); err == nil && strings.EqualFold(pu.Hostname(), base.Hostname()) {
			c.URL = u // canonical URL on the same host only
		}
	}
	if icon == "" {
		icon = "/favicon.ico"
	}
	c.Favicon = abs(base, icon)
	return c
}
