# Contributing

## Setup

Requires [Bun](https://bun.sh) ≥ 1.3. No Node.js needed.

```bash
git clone https://github.com/danielhurtado714/whatsapp-agent.git
cd whatsapp-agent
bun install
```

## Development

```bash
bun run src/cli/index.ts bridge   # run the bridge from source (--login, --pair, ...)
bun run src/cli/index.ts mcp      # run the MCP server from source
bun run src/cli/index.ts setup    # run the setup wizard from source

bun run typecheck                 # tsc --noEmit, covers src/**/*.ts including tests
bun run lint                      # biome check .
bun run format                    # biome format --write .
bun test                          # unit tests (bun:test)
bun run test:e2e                  # HTTP + stdio-MCP integration test, no real WhatsApp
```

`test:e2e` also accepts `WA_TEST_BIN=<path>` to run the exact same suite against a
compiled binary instead of source:

```bash
bun run scripts/build-binaries.ts self
WA_TEST_BIN=./dist/bin/whatsapp-agent-<platform> bun run test:e2e
```

## Conventions

- **English only** — code, comments, log messages, error strings, and anything an LLM
  reads via the MCP tools. This project used to be Spanish-only; if you're porting old
  code, translate it as you go.
- **No new native dependencies.** The whole point of the `bun:sqlite` migration was
  zero-runtime-dep standalone binaries via `bun build --compile`. A native addon breaks
  that for every platform we don't build on.
- **`src/mcp/**` and `src/cli/**` must never write to stdout outside their own intended
  output.** stdio JSON-RPC breaks on a single stray byte. `console.log` is a lint error
  in those paths for exactly this reason — use `console.error`/`process.stderr.write`,
  or route through the existing logger.
- Commit messages: explain *why*, not just *what*. Conventional-commit-style prefixes
  (`feat:`, `fix:`, `refactor:`, `chore:`) are appreciated but not enforced.

## Building binaries

```bash
bun run scripts/build-binaries.ts               # all 5 targets
bun run scripts/build-binaries.ts bun-linux-x64 # one target
bun run scripts/build-binaries.ts self          # whatever matches this machine
```

Don't cross-compile the macOS targets for a real release — build them natively so
codesigning happens on the same machine (`build-binaries.ts` does this automatically
when run on macOS).

## Tests for anything touching the setup wizard or service installer

`src/setup/jsonConfig.ts` and `src/service/{launchd,systemd}.ts` are the highest-blast-
radius code in the repo — they write to real config files and system service managers
on a user's machine. Any change there needs test coverage in the corresponding
`*.test.ts`, not just a manual check. In particular:

- Never let a test touch your real `~/.claude.json`, Claude Desktop config, or install a
  real launchd/systemd service — use a scratch directory (see the existing tests for the
  pattern).
- If you change `ensureJsonKey`'s write/backup/verify algorithm, re-run the full
  `jsonConfig.test.ts` suite; it's the regression net for the single most damaging class
  of bug this project could ship (corrupting someone's AI client config).
