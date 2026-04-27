# Contributing

## Dev dependencies

`typescript` and `@types/node` are the agreed toolchain to build the project (see `package.json`). No additional approval is required to rely on them for this repository.

## Quick loop

```bash
npm install
npm test
```

`npm test` compiles with `tsc` and runs `node --test` on the files under `test/`. Use `npm run typecheck` for a no-emit check only.

## Branches and CI

- Open PRs against `main`. CI runs `npm test` (Linux + macOS, Node 20/22) and a smoke `docker build` on Ubuntu.
- Keep changes scoped; match existing style and run tests before pushing.

## Security and process CLIs

The app shells out to your configured `codex` and `claude` binaries (never via `shell: true`). If spawn fails with “not found on PATH or not executable”, install the tool or set an absolute `command` in the JSON config.
