.PHONY: help dev dashboard check test test-fast test-ui test-browser test-properties test-explorer test-mutation check-model reference

help:
	@echo "dev dashboard check test test-fast test-ui test-browser test-properties test-explorer test-mutation check-model reference"
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
test-properties:
	bun run test:properties
test-explorer:
	bun run test:explorer
reference:
	bun run docs:api

test-mutation:
	bun run test:mutation
check-model:
	bun run check:model
