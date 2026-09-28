## What / Что

<!-- One paragraph: what changes and why. Link the issue: Fixes #123 -->

## Checks / Проверки

- [ ] `pnpm -s typecheck && pnpm -s lint && pnpm -s test`
- [ ] Server (if touched): `make lint`, `go test -race ./...` in `apps/server`
- [ ] Generated code committed (`make gen`, no drift)
- [ ] UI change: screenshots attached (dark 960); visual baselines updated only for the screens you changed
- [ ] Docs updated when behaviour or the contract changed (`docs/`, ADR for architectural decisions)

## Contributor License Agreement

- [ ] I have read `CONTRIBUTING.md` and agree to the CLA (BUSL-1.1 project; I have the right to submit this contribution).
