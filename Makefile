.PHONY: gen dev-server test test-integration lint third-party-notices

TEST_DATABASE_URL ?= postgres://calaba:calaba@localhost:55432/calaba
# Valkey DB of internal/app integration tests (flushed); give each worktree its own number
TEST_REDIS_DB     ?= 15
TEST_REDIS_URL    ?= redis://localhost:56379/$(TEST_REDIS_DB)
# internal/rtc integration tests use their own Valkey DB (flushed); see TESTING «Параллельные прогоны»
TEST_RTC_REDIS_DB ?= 14

gen:            ## generate Go + TS from proto/ and Go from SQL (run `pnpm install` once first)
	buf generate
	cd apps/server && sqlc generate

# Dev defaults match infra/docker/compose.dev.yml (postgres :55432, redis :56379, livekit devkey/secret).
dev-server:
	cd apps/server && \
	DATABASE_URL=$${DATABASE_URL:-postgres://calaba:calaba@localhost:55432/calaba} \
	REDIS_URL=$${REDIS_URL:-redis://localhost:56379/0} \
	JWT_SECRET=$${JWT_SECRET:-dev-only-jwt-secret-dev-only-jwt-secret} \
	REGISTRATION_MODE=$${REGISTRATION_MODE:-open} \
	LIVEKIT_URL=$${LIVEKIT_URL:-ws://localhost:7880} LIVEKIT_INTERNAL_URL=$${LIVEKIT_INTERNAL_URL:-http://localhost:7880} \
	LIVEKIT_API_KEY=$${LIVEKIT_API_KEY:-devkey} LIVEKIT_API_SECRET=$${LIVEKIT_API_SECRET:-secret} \
	go run ./cmd/server

test:           ## unit tests (no external services)
	cd apps/server && go test ./...
	pnpm -r test

test-integration: ## Go integration tests against dev Postgres 18 + Redis 7.4 + LiveKit (pnpm infra:dev)
	cd apps/server && TEST_DATABASE_URL=$(TEST_DATABASE_URL) TEST_REDIS_URL=$(TEST_REDIS_URL) TEST_RTC_REDIS_DB=$(TEST_RTC_REDIS_DB) \
		go test -tags integration -count=1 ./...

lint:
	cd apps/server && go vet ./... && go vet -tags integration ./... && \
		golangci-lint run --config ../../.golangci.yml --build-tags integration ./...
	pnpm -r lint

# License texts of the Go modules linked into the server (copied into the image). Fails on
# GPL / LGPL / AGPL or unrecognised licenses. Re-run after dependency changes and commit.
third-party-notices:
	cd apps/server && go run ./tools/notices > THIRD-PARTY-NOTICES.txt.tmp && \
		mv THIRD-PARTY-NOTICES.txt.tmp THIRD-PARTY-NOTICES.txt
