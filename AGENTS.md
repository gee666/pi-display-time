# Maintenance instructions

Keep this root `AGENTS.md` tracked and current. Update it whenever the stack, commands, boundaries, test policy, or release process changes. Treat it as a maintenance requirement, not a one-time checklist.

## Repository synchronization

- Before starting any work, pull the latest changes from `origin` with `git pull --ff-only`. Preserve local edits; stop and resolve safely if the pull is blocked.
- After each completed, validated piece of work, commit your changes and push to `origin` immediately. Work happens on multiple machines; do not leave finished work unsynchronized.

## Stack and boundaries

This is an ESM TypeScript Pi extension. Keep timing calculations in `extensions/timing.ts`, Pi lifecycle and UI integration in `extensions/display-time.ts`, and regression tests in `tests/`. Use public Pi APIs; never replace tools or their renderers.

Pi supplies its packages at runtime. Declare imported Pi packages as peers and direct development dependencies, never runtime dependencies. Follow existing naming, formatting, module boundaries, and Pi package conventions unless a documented requirement calls for a change.

## Quality bar

- Remove dead code, unused imports, obsolete assets, and unused dependencies from changed areas.
- Prefer the simplest correct implementation. Avoid duplicated logic and speculative abstractions.
- Fix root causes rather than hiding symptoms. Keep configuration explicit and validated. Never commit secrets, credentials, private paths, or local auth state.
- Keep TypeScript strict. Validate untrusted files, persisted data, flags, and editor capabilities at runtime. Use narrowing, not `any`, unsafe casts, non-null assertions that hide missing data, or diagnostic suppressions to make checks pass.
- Keep files focused and under 350 lines. Document a cohesion-based reason in this file before exceeding that limit.
- Write short, accurate docs that match commands and behavior. Use the `unslop` and `write-prompts` skills when available for documentation and prompt instructions. Do not invent compatibility or test claims.
- Add regression tests for behavior changes, including failures and boundaries. Keep tests deterministic where possible. Package and asset validation must check real declared resources; it does not prove runtime compatibility.
- Run `npm test`, which refreshes Pi and runs strict typechecking before tests. Run any configured lint command too. No separate linter is currently configured. Run `git diff --check` and inspect `npm pack --dry-run --ignore-scripts` before release.

## Latest-only Pi tests and releases

- Test only the current npm `latest` Pi release. Do not maintain an older-version matrix, fall back to an older release, or use a cached install as evidence of latest compatibility.
- `pretest` must install `@earendil-works/pi-coding-agent@latest` and `@earendil-works/pi-tui@latest` with `--save-dev --ignore-scripts`, then run `npm run check`. A failed refresh or check must stop the tests.
- Keep `package.json` and `package-lock.json` in sync. Inspect dependency changes rather than forcing upgrades or suppressing diagnostics.
- For every release, run the checks against npm latest and record the installed agent and TUI versions. Set the README line to `Tested against Pi <actual version>` only after checks pass. State what tests cover and any manual checks not performed.
- The peer minimum is Pi 1.4.0, the tested baseline. A peer range is not a promise of tests on every version in the range. Raise the minimum when required by tested APIs; do not claim older support without evidence.
- Do not bump the package version unless the release task asks for it.

Use this repository's `tmp/` directory for temporary files and keep it untracked. Give every shell command an explicit timeout.
