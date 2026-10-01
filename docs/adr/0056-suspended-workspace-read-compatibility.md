# ADR-0056: чтение приостановленного workspace локальной сессией

Статус: принято лидом, 2026-10-01; уточняет ADR-0054 и release-2.0-identity §2/§13.

## Контекст

Прежняя приостановка workspace (docs/04, раздел модерации) запрещает запись и голос,
но сохраняет чтение истории, участников и READY, а owner/admin видят причину. Общий
запрет suspended workspace в новой identity policy непреднамеренно отменил этот контракт.

## Решение лида

Только живая local_account в workspace с текущей policy off/optional сохраняет
WorkspaceRead. Проверки membership/ban, member suspension, directory status/freshness,
версий policy/entitlement и существующие ACL остаются обязательны, без раннего allow.
Enforced, workspace_sso и recovery не получают исключение. Bot credentials не получают
нового исключения. Отсутствующая policy использует только существующий migration off default.

Пассивные gateway leases, READY и replay используют WorkspaceRead; лимит 30 секунд
и окончательная проверка перед socket write сохраняются. SUBSCRIBE меняет только
подписку принимающей сессии. TYPING — публикация, поэтому независимо проверяет Realtime
по свежей policy вне gateway locks; receive lease не разрешает эту команду.
WorkspaceWrite, Realtime publication, RTC, OAuth issuance/UserInfo и identity management
остаются запрещены при suspension. GET/HEAD классифицируются как чтение; mutating HTTP
methods не получают это исключение. Новых proto/SQL полей и внешних API нет.

## Приёмка

Прежний TestWorkspaceSuspension проходит без изменения assertions: история/участники/
READY читаются, причина скрыта от member, записи и RTC запрещены. Дополнительные тесты
проверяют off/optional, scoped/recovery/enforced, revoked session, missing/suspended member,
disabled/stale directory, OAuth/management и отсутствие TYPING от read-only сессии.
