.PHONY: gen dev-server test test-integration lint

TEST_DATABASE_URL ?= postgres://calaba:calaba@localhost:55432/calaba
TEST_REDIS_URL    ?= redis://localhost:56379/15

gen:            ## generate Go + TS from proto/ and Go from SQL (run `pnpm install` once first)
	buf generate
	cd apps/server && sqlc generate

dev-server:
	cd apps/server && go run ./cmd/server

test:           ## unit tests (no external services)
	cd apps/server && go test ./...
	pnpm -r test

test-integration: ## Go integration tests against dev Postgres 18 + Redis (pnpm infra:dev)
	cd apps/server && TEST_DATABASE_URL=$(TEST_DATABASE_URL) TEST_REDIS_URL=$(TEST_REDIS_URL) \
		go test -tags integration -count=1 ./...

lint:
	cd apps/server && go vet ./... && go vet -tags integration ./... && \
		golangci-lint run --config ../../.golangci.yml --build-tags integration ./...
	pnpm -r lint
