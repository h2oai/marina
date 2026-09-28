.PHONY: help dev dashboard check test test-fast test-ui test-browser reference

help:
	@echo "dev dashboard check test test-fast test-ui test-browser reference"
	@echo "Each target delegates to the documented package scripts. make test runs backend tests."
dev:
	bun run dev
dashboard:
	bun run dashboard:dev
check:
	bun run typecheck
	bun run lint
test:
	bun run test
test-fast:
	bun run test:fast
test-ui:
	bun run test:ui
test-browser:
	bun run test:browser
reference:
	bun run docs:api
