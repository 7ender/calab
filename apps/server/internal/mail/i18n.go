package mail

// Dictionary of the mail templates (ADR-0023). Style (owner, 27.09): minimal and short — a
// title, one line, the code or one button, a grey note; no salutations. Terms follow
// docs/i18n-glossary.md (workspace = пространство / espacio / 工作区). Placeholders:
// {{.code}}, {{.minutes}}, {{.workspace}}, {{.inviter}}, {{.days}}. Plain strings: HTML
// escaping is done by the renderer.

type texts struct {
	Subject string
	Title   string
	Line    string
	Button  string // link label (templates with a url); code templates show the code
	Note    string // grey: validity / "if it wasn't you"
	// Invitations: numbered steps under the line, and the invitation code as text for when the
	// link does not open (shown only with a "code" param: "<CodeHint>" + "<CodeLabel>: <code>").
	Steps     []string
	CodeHint  string
	CodeLabel string
	// Meetings: labelled rows (shown when their param is set) and secondary link buttons
	// (shown when their param is an http(s) URL).
	Details []detail
	Actions []action
}

type detail struct{ Label, Param string }
type action struct{ Label, Param string }

var dict = map[string]map[Template]texts{
	LocaleEN: {
		TemplateVerifyCode: {
			Subject: "Verification code: {{.code}}", Title: "Confirm your email",
			Line: "Enter this code in Calab to confirm your email address.",
			Note: "The code is valid for {{.minutes}} minutes. If it wasn’t you, ignore this email.",
		},
		TemplatePasswordReset: {
			Subject: "Password reset code: {{.code}}", Title: "Reset your password",
			Line: "Enter this code in Calab to set a new password.",
			Note: "The code is valid for {{.minutes}} minutes. If you didn’t ask for it, ignore this email — your password stays the same.",
		},
		TemplateWorkspaceAdded: {
			Subject: "You were added to “{{.workspace}}”", Title: "You’re in “{{.workspace}}”",
			Line:   "{{.inviter}} added you to the workspace “{{.workspace}}” in Calab.",
			Button: "Open Calab",
			Note:   "It is already in your list of workspaces.",
		},
		TemplateWorkspaceInvite: {
			Subject: "You’re invited to “{{.workspace}}”", Title: "Join “{{.workspace}}”",
			Line:   "{{.inviter}} invited you to the workspace “{{.workspace}}” in Calab, a voice-first team messenger.",
			Button: "Accept invitation",
			Note:   "The link is valid for {{.days}} days and only for this email address. If you weren’t expecting it, ignore this email.",
			Steps: []string{
				"Open the “Accept invitation” link.",
				"Create an account — your email address is already filled in.",
				"Enter the confirmation code from the next email — and you’re in the workspace.",
			},
			CodeHint:  "Link not opening? Sign up in Calab with this email address and enter the invitation code.",
			CodeLabel: "Invitation code",
		},
	},
	LocaleRU: {
		TemplateVerifyCode: {
			Subject: "Код подтверждения: {{.code}}", Title: "Подтвердите почту",
			Line: "Введите этот код в Calab, чтобы подтвердить адрес почты.",
			Note: "Код действует {{.minutes}} минут. Если это были не вы — проигнорируйте письмо.",
		},
		TemplatePasswordReset: {
			Subject: "Код для сброса пароля: {{.code}}", Title: "Сброс пароля",
			Line: "Введите этот код в Calab, чтобы задать новый пароль.",
			Note: "Код действует {{.minutes}} минут. Если вы не запрашивали сброс — проигнорируйте письмо, пароль останется прежним.",
		},
		TemplateWorkspaceAdded: {
			Subject: "Вас добавили в «{{.workspace}}»", Title: "Вы в «{{.workspace}}»",
			Line:   "{{.inviter}} добавил(а) вас в пространство «{{.workspace}}» в Calab.",
			Button: "Открыть Calab",
			Note:   "Оно уже есть в вашем списке пространств.",
		},
		TemplateWorkspaceInvite: {
			Subject: "Вас пригласили в «{{.workspace}}»", Title: "Приглашение в «{{.workspace}}»",
			Line:   "{{.inviter}} приглашает вас в пространство «{{.workspace}}» в Calab — мессенджере для команды, где голос на первом месте.",
			Button: "Принять приглашение",
			Note:   "Ссылка действует {{.days}} дней и только для этого адреса почты. Если вы не ждали приглашения — проигнорируйте письмо.",
			Steps: []string{
				"Откройте ссылку «Принять приглашение».",
				"Создайте аккаунт — адрес почты уже подставлен.",
				"Введите код подтверждения из следующего письма — и вы в пространстве.",
			},
			CodeHint:  "Ссылка не открывается? Зарегистрируйтесь в Calab с этим адресом почты и укажите код приглашения.",
			CodeLabel: "Код приглашения",
		},
	},
	LocaleES: {
		TemplateVerifyCode: {
			Subject: "Código de verificación: {{.code}}", Title: "Confirma tu correo",
			Line: "Introduce este código en Calab para confirmar tu dirección de correo.",
			Note: "El código es válido durante {{.minutes}} minutos. Si no fuiste tú, ignora este correo.",
		},
		TemplatePasswordReset: {
			Subject: "Código para restablecer la contraseña: {{.code}}", Title: "Restablece tu contraseña",
			Line: "Introduce este código en Calab para crear una contraseña nueva.",
			Note: "El código es válido durante {{.minutes}} minutos. Si no lo pediste, ignora este correo: tu contraseña no cambiará.",
		},
		TemplateWorkspaceAdded: {
			Subject: "Te añadieron a «{{.workspace}}»", Title: "Ya estás en «{{.workspace}}»",
			Line:   "{{.inviter}} te añadió al espacio «{{.workspace}}» en Calab.",
			Button: "Abrir Calab",
			Note:   "Ya aparece en tu lista de espacios.",
		},
		TemplateWorkspaceInvite: {
			Subject: "Te invitaron a «{{.workspace}}»", Title: "Únete a «{{.workspace}}»",
			Line:   "{{.inviter}} te invitó al espacio «{{.workspace}}» en Calab, un mensajero de equipo centrado en la voz.",
			Button: "Aceptar invitación",
			Note:   "El enlace es válido durante {{.days}} días y solo para esta dirección de correo. Si no lo esperabas, ignora este correo.",
			Steps: []string{
				"Abre el enlace «Aceptar invitación».",
				"Crea una cuenta: tu dirección de correo ya está rellenada.",
				"Introduce el código de confirmación del siguiente correo y ya estarás en el espacio.",
			},
			CodeHint:  "¿No se abre el enlace? Regístrate en Calab con esta dirección de correo e introduce el código de invitación.",
			CodeLabel: "Código de invitación",
		},
	},
	LocaleZhCN: {
		TemplateVerifyCode: {
			Subject: "验证码：{{.code}}", Title: "确认你的邮箱",
			Line: "在 Calab 中输入此验证码，以确认你的邮箱地址。",
			Note: "验证码在 {{.minutes}} 分钟内有效。如果不是你本人操作，请忽略此邮件。",
		},
		TemplatePasswordReset: {
			Subject: "重置密码验证码：{{.code}}", Title: "重置密码",
			Line: "在 Calab 中输入此验证码，以设置新密码。",
			Note: "验证码在 {{.minutes}} 分钟内有效。如果你没有请求重置，请忽略此邮件，你的密码不会改变。",
		},
		TemplateWorkspaceAdded: {
			Subject: "你已被添加到“{{.workspace}}”", Title: "你已加入“{{.workspace}}”",
			Line:   "{{.inviter}} 已将你添加到 Calab 的工作区“{{.workspace}}”。",
			Button: "打开 Calab",
			Note:   "它已出现在你的工作区列表中。",
		},
		TemplateWorkspaceInvite: {
			Subject: "你被邀请加入“{{.workspace}}”", Title: "加入“{{.workspace}}”",
			Line:   "{{.inviter}} 邀请你加入 Calab 的工作区“{{.workspace}}”——一款以语音为核心的团队通讯工具。",
			Button: "接受邀请",
			Note:   "链接在 {{.days}} 天内有效，且仅限此邮箱地址使用。如果你没有预料到这份邀请，请忽略此邮件。",
			Steps: []string{
				"打开“接受邀请”链接。",
				"创建账户——邮箱地址已自动填好。",
				"输入下一封邮件中的验证码，即可进入工作区。",
			},
			CodeHint:  "链接打不开？请在 Calab 中使用此邮箱地址注册，并填写邀请码。",
			CodeLabel: "邀请码",
		},
	},
}
