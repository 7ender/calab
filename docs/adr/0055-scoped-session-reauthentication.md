# ADR-0055: повторная аутентификация scoped SSO-сессии

Статус: принято лидом для реализации 2.0, 2026-10-01; приёмка не завершена.
Уточняет [ADR-0054](0054-workspace-identity.md).

## Причина

Сквозной browser/App/Keycloak сценарий обнаружил тупик OAuth consent с
`prompt=login`/`max_age`: UI предлагает `step_up`, но сервер разрешает его только
local account. Замена scoped session через login меняет session id и нарушает
привязку исходного consent. Ослаблять проверку свежести или расширять authority нельзя.

## Решение

- Provider `auth_time` определяется authority: для `local_account` это независимая
  local authentication, для `workspace_sso` — корпоративная authentication этой
  сессии. Workspace assurance не обновляет local proof. Локальному пользователю
  могут потребоваться и local reauth, и SSO; UI сохраняет оба явных действия.
- Существующий `step_up` допускает повторную аутентификацию **живой**
  `workspace_sso(A)` только в A, через её текущую active connection и ту же явно
  связанную external identity. Begin связывает исходные session/user/workspace/
  connection/identity и версии; callback и finish/exchange перепроверяют их.
  Смена subject/account, connection, policy/member/directory/entitlement/session
  epoch или отзыв отклоняют flow. Recovery, guest, bot и чужое пространство запрещены.
- Результат обновляет только assurance той же сессии. Он не выдаёт новые tokens,
  не меняет authority, session id, local proof или исходный абсолютный session
  deadline. Assurance ограничена этим deadline и актуальными grants/directory.
  Старые OAuth grants сохраняют исходные auth_time/deadlines; refresh их не продлевает.
- Истёкшая/отозванная сессия требует нового login и нового authorization request,
  а не восстановления через step-up. Same-session consent return остаётся
  одноразовым, exact same-origin и ограниченным исходными flow/request deadlines.
  Local reauth не заменяет SSO, SSO не заменяет local reauth.

## Приёмка

Real browser + App + Keycloak: local consent после local reauth и требуемого SSO;
scoped consent после same-session step-up с новым auth_time. Проверить прежние
authority/session/deadline, отсутствие новых tokens/local proof, запрет B/DM/global,
changed subject/version/revocation/expiry и повторное использование flow. Ни новый
enum/API, ни расширение доступа к данным этим решением не вводятся.
