.PHONY: help install test native-test native-coverage coverage typecheck lint hooks hooks-install secrets prerequisites check
TEST_PATH = ./test
help:
	@printf '%s\n' 'install test native-test native-coverage coverage typecheck lint hooks hooks-install secrets prerequisites check'
install:
	bun install
test:
	bun test $(TEST_PATH)
native-test:
	BACKSEAT_NATIVE_HOST_TESTS=1 bun test ./test/coordination-tui.test.ts ./test/worker-supervision.test.ts --timeout 60000
native-coverage:
	BACKSEAT_NATIVE_HOST_TESTS=1 bun test ./test/coordination-tui.test.ts ./test/worker-supervision.test.ts --timeout 60000 --coverage --coverage-reporter=lcov --coverage-dir=coverage/native
coverage:
	bun test ./test --coverage --coverage-reporter=lcov
typecheck:
	bunx tsc -p tsconfig.json
lint:
	bunx eslint src test
hooks-install:
	pre-commit install --install-hooks --hook-type pre-commit --hook-type commit-msg
hooks:
	pre-commit run --all-files
secrets:
	uvx --from detect-secrets==1.5.0 detect-secrets scan > .secrets.baseline
prerequisites:
	@test "$$(uname -s)" = Linux || { printf '%s\n' 'Native coordination requires Linux'; exit 1; }
	@test -x /usr/bin/flock || { printf '%s\n' 'Native coordination requires a trusted /usr/bin/flock'; exit 1; }
	@/usr/bin/flock --version
check: prerequisites test typecheck lint hooks
