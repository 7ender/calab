package mail

import (
	"bytes"
	"fmt"
	htmltemplate "html/template"
	"strings"
	"text/template"
	"unicode"

	"github.com/calaba/calaba/server/internal/buildinfo"
)

// Template names a kind of mail (mail_outbox.template).
type Template string

// Templates (ADR-0023).
const (
	TemplateVerifyCode      Template = "verify_code"      // code, minutes
	TemplatePasswordReset   Template = "password_reset"   // code, minutes
	TemplateWorkspaceAdded  Template = "workspace_added"  // workspace, inviter, url
	TemplateWorkspaceInvite Template = "workspace_invite" // workspace, inviter, url, days; code (optional)
)

// ProductURL is the product site linked from every mail's footer (docs/10-branding.md).
const ProductURL = "https://calab.ru"

// Params are a template's values (strings only).
type Params map[string]string

// templates: required params of each template; templates with a Button show a link to
// "url", the others the "code".
var templates = map[Template][]string{
	TemplateVerifyCode:      {"code", "minutes"},
	TemplatePasswordReset:   {"code", "minutes"},
	TemplateWorkspaceAdded:  {"workspace", "inviter", "url"},
	TemplateWorkspaceInvite: {"workspace", "inviter", "url", "days"},
}

// Templates lists every template (tests).
func Templates() []Template {
	out := make([]Template, 0, len(templates))
	for t := range templates {
		out = append(out, t)
	}
	return out
}

// Locales lists every supported locale (tests).
func Locales() []string { return []string{LocaleEN, LocaleRU, LocaleES, LocaleZhCN} }

// clean makes a user-controlled value safe for a header and a single line: control
// characters (CR/LF included) become spaces, and it is clipped to 100 characters.
func clean(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, strings.TrimSpace(s))
	if r := []rune(s); len(r) > 100 {
		s = string(r[:100]) + "…"
	}
	return s
}

func expand(src string, p Params) (string, error) {
	t, err := template.New("").Option("missingkey=error").Parse(src)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	if err := t.Execute(&b, map[string]string(p)); err != nil {
		return "", err
	}
	return b.String(), nil
}

// One wrapper for every mail: ≤ 560 px, system font, light by default and dark through
// prefers-color-scheme (clients without <style> support get the inline light colors).
var htmlPage = htmltemplate.Must(htmltemplate.New("mail").Parse(`<!doctype html>
<html lang="{{.Lang}}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>{{.Subject}}</title>
<style>
@media (prefers-color-scheme: dark) {
  .bg { background:#0f0f11 !important; }
  .card { background:#1a1a1d !important; border-color:#2a2a2e !important; }
  .fg { color:#f4f4f5 !important; }
  .muted { color:#a1a1aa !important; }
  .btn { background:#f4f4f5 !important; color:#0f0f11 !important; }
}
</style></head>
<body class="bg" style="margin:0;padding:32px 16px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<div class="card" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e4e4e7;border-radius:16px;padding:32px">
<p class="fg" style="margin:0 0 28px;font-size:15px;font-weight:700;letter-spacing:.2px;color:#18181b">Calab</p>
<h1 class="fg" style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:600;color:#18181b">{{.Title}}</h1>
<p class="fg" style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#18181b">{{.Line}}</p>
{{if .Steps}}<ol class="fg" style="margin:0 0 24px;padding-left:22px;font-size:15px;line-height:1.55;color:#18181b">{{range .Steps}}<li style="margin:0 0 6px">{{.}}</li>{{end}}</ol>
{{end}}{{if .Code}}<p class="fg" style="margin:0 0 24px;font-size:34px;line-height:1;font-weight:600;letter-spacing:8px;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;color:#18181b">{{.Code}}</p>
{{end}}{{if .URL}}<p style="margin:0 0 24px"><a class="btn" href="{{.URL}}" style="display:inline-block;padding:12px 24px;border-radius:999px;background:#18181b;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600">{{.Button}}</a></p>
{{end}}{{if .InviteCode}}<p class="muted" style="margin:0 0 6px;font-size:13px;line-height:1.55;color:#71717a">{{.CodeHint}}</p>
<p class="fg" style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#18181b">{{.CodeLabel}}: <span style="font-weight:600;letter-spacing:1px;font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace">{{.InviteCode}}</span></p>
{{end}}<p class="muted" style="margin:0;font-size:13px;line-height:1.55;color:#71717a">{{.Note}}</p>
</div>
<p class="muted" style="max-width:560px;margin:16px auto 0;text-align:center;font-size:12px;line-height:1.5;color:#71717a"><a class="muted" href="{{.AttributionURL}}" style="color:#71717a">{{.Attribution}}</a> · <a class="muted" href="{{.ProductURL}}" style="color:#71717a">calab.ru</a></p>
</body></html>
`))

// Render builds the message of template t in locale (fallback English). Missing required
// params are an error (a bug in the caller: the mail is not retried).
func Render(t Template, locale string, p Params) (Message, error) {
	req, ok := templates[t]
	if !ok {
		return Message{}, &PermanentError{fmt.Errorf("mail: unknown template %q", t)}
	}
	locale = Locale(locale)
	tx := dict[locale][t]
	vals := Params{}
	for k, v := range p {
		vals[k] = clean(v)
	}
	for _, k := range req {
		if vals[k] == "" {
			return Message{}, &PermanentError{fmt.Errorf("mail: template %s: missing %q", t, k)}
		}
	}
	var err error
	x := func(src string) string {
		if err != nil || src == "" {
			return ""
		}
		var out string
		out, err = expand(src, vals)
		return out
	}
	data := struct {
		Lang, Subject, Title, Line, Code, URL, Button, Note string
		Steps                                               []string
		CodeHint, CodeLabel, InviteCode                     string
		Attribution, AttributionURL, ProductURL             string
	}{
		Lang: locale, Subject: x(tx.Subject), Title: x(tx.Title), Line: x(tx.Line), Note: x(tx.Note),
		Button: tx.Button, Attribution: buildinfo.Attribution, AttributionURL: buildinfo.AttributionURL, ProductURL: ProductURL,
	}
	for _, st := range tx.Steps {
		data.Steps = append(data.Steps, x(st))
	}
	if tx.Button != "" {
		data.URL = vals["url"]
		// The invitation code as text: the fallback when the link does not open.
		if tx.CodeLabel != "" && vals["code"] != "" {
			data.CodeHint, data.CodeLabel, data.InviteCode = x(tx.CodeHint), tx.CodeLabel, vals["code"]
		}
	} else {
		data.Code = vals["code"]
	}
	if err != nil {
		return Message{}, &PermanentError{fmt.Errorf("mail: template %s/%s: %w", t, locale, err)}
	}

	var text strings.Builder
	text.WriteString(data.Title + "\n\n" + data.Line + "\n\n")
	for i, st := range data.Steps {
		fmt.Fprintf(&text, "%d. %s\n", i+1, st)
	}
	if len(data.Steps) > 0 {
		text.WriteString("\n")
	}
	if data.Code != "" {
		text.WriteString(data.Code + "\n\n")
	}
	if data.URL != "" {
		text.WriteString(data.Button + ": " + data.URL + "\n\n")
	}
	if data.InviteCode != "" {
		text.WriteString(data.CodeHint + "\n" + data.CodeLabel + ": " + data.InviteCode + "\n\n")
	}
	text.WriteString(data.Note + "\n\n-- \n" + buildinfo.Attribution + " — " + buildinfo.AttributionURL + "\nCalab — " + ProductURL + "\n")

	var html bytes.Buffer
	if err := htmlPage.Execute(&html, data); err != nil {
		return Message{}, &PermanentError{err}
	}
	return Message{Subject: data.Subject, Text: text.String(), HTML: html.String(), Template: t, Params: p}, nil
}
