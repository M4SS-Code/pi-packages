---
name: repo-maintenance
license: MIT
description: >
  Maintain repository dependencies and CI for Rust (Cargo) and Node.js (pnpm).
  Use when asked to update, upgrade or bump dependencies, handle RustSec or npm
  security advisories, bump the MSRV, or audit or refresh GitHub Actions and
  Forgejo Actions workflows.
---

# Repository maintenance

Update dependencies and audit CI through small, reviewable local commits, then
report what still needs a decision.

## Pick the procedure

| Task                                                  | Read                       |
| ----------------------------------------------------- | -------------------------- |
| Rust dependencies, the MSRV, RustSec advisories       | `references/rust.md`       |
| Node.js dependencies with pnpm, npm advisories        | `references/node.md`       |
| Reviewing an upgrade: changelog and release diff      | `references/changelogs.md` |
| Auditing CI, refreshing pinned actions and toolchains | `references/ci-audit.md`   |
| Forgejo Actions, and our code.m4ss.net runners        | `references/forgejo.md`    |

Paths are relative to this skill's directory. Inspect `Cargo.lock`,
`pnpm-lock.yaml`, `.github/workflows/`, `.forgejo/workflows/` and
`.gitlab-ci.yml` to see which procedures apply. For a Rust workspace with a
SvelteKit frontend, run both dependency procedures in sequence (run pnpm from
the directory containing `pnpm-lock.yaml`). Review every major upgrade with
`references/changelogs.md`.

Run the CI audit when asked, or propose it when the workflows haven't changed in
months (`git log -1 --format=%cs -- .github .forgejo .gitlab-ci.yml`).

## Our repositories

A repository is **ours** when all of the following hold:

1. Its `git remote -v` URL is on `code.m4ss.net` or under `github.com/M4SS-Code`.
2. It is **not** a mirror or fork of an external project (exclude `Mirror/<repo>`
   on `code.m4ss.net` whose `original_url` is outside `M4SS-Code`, forks under
   `M4SS-Code`, and action mirrors under `Actions/` except `Actions/ci-images`).

Two rules apply to our repositories:

- **Keep `deny.toml` and CI configs aligned across siblings.** Before changing
  either, compare with sibling repositories (`references/ci-audit.md`, "Keeping
  our repositories alike") and align any drift. If the shared template itself
  needs a fix, fix it here and list every sibling repository that needs the same
  change in the report.
- **Never reference `code.m4ss.net` outside our repositories.** Its mirrors,
  runner images and conventions (`references/forgejo.md`) are strictly for our
  repositories.

## Ground rules

- Load the `commit` skill before creating the first commit. It governs staging,
  message formatting and folding fixes into earlier commits; this skill defines
  commit grouping, subjects and required checks. Never run `git push`.
- Record the starting commit (`git rev-parse HEAD`, called `<base>` below),
  check `git status --short` (stop and ask if files the run will touch are
  already dirty), and create a temporary directory outside the repository
  (`mktemp -d`, called `<scratch>` below). Each command may run in a new
  shell, so a variable does not survive: copy the path that `mktemp -d`
  prints literally into later commands, and never save it to a file. Put
  every temporary file in `<scratch>`: baselines, lockfile copies, cloned
  upstream repositories and `git worktree` checkouts. Never create other
  paths in `/tmp`. At the end of the run, remove any worktrees
  (`git worktree remove`) and then `<scratch>`.
- Treat code in releases under review as untrusted: read it, and never build,
  test, install or execute anything from it before review.
- Use `curl` against `https://api.github.com/...` or
  `raw.githubusercontent.com` for read-only GitHub queries instead of `gh`.
  Pass `-H "Authorization: Bearer ${GITHUB_TOKEN:-$GH_TOKEN}"` when either
  token is set.
- Run the exact check commands from the repository's CI with `--locked` or
  `--frozen-lockfile`. For each commit, run the checks covering what changed
  (build, clippy and tests across CI's feature combinations, the MSRV job,
  cargo-deny; or pnpm's `check`, `lint`, `test` and `build`), then run the full
  set at the end. List any CI jobs that cannot run locally (external services,
  large feature powersets, coverage uploads) in the report.
- Do not run `cargo hack --feature-powerset` locally; list it in the report
  instead. Never interrupt `cargo hack ... --no-dev-deps` or run it in the
  background: it deletes `[dev-dependencies]` from the manifests while it runs
  and restores them only when it exits normally. If one was interrupted,
  restore the manifests with `git checkout -- '*Cargo.toml'`.
- When a check fails and the reference file specifies a recovery step (such as
  holding back a regressed compatible release or fixing new MSRV lints), follow
  it; otherwise keep the failure visible and stop to ask.
- Query current versions, release dates, runner labels and advisories on every
  run. Statements marked "at the time of writing" reflect November 2026:
  re-verify them before acting.

## When to upgrade within the declared ranges

Check when lockfiles were last updated:
`git log -10 --format='%cs %s' -- '*Cargo.lock' '*pnpm-lock.yaml'`.

Run a compatible upgrade when any of the following applies:

- the last compatible upgrade is more than a few weeks old;
- a compatible release fixes an advisory affecting a locked version;
- a release that ships the lockfile (a binary, container image or deployed app,
  not a library) is about to be cut; or
- the user explicitly asked for a compatible upgrade.

If none applies, ask before running the compatible upgrade, and still run the
advisory, MSRV and major-version checks.

## Stop and ask

Gather the evidence first, then stop and ask the user when:

- a newer version is held back by the MSRV;
- an applicable advisory has no fix, or its fix requires an override, MSRV bump
  or upstream release;
- an update introduces an unallowed license, or an install script that must run
  (disabling an unneeded install script does not require approval);
- a version younger than the one-day release-age gate is needed for anything
  other than an audited fix for an applicable security advisory;
- a major upgrade requires a large migration, or upgrades conflict;
- a workflow in one of our repositories needs an action not yet mirrored on
  `code.m4ss.net`;
- aligning a repository with siblings would drop an existing check;
- any action would push, publish or delete.

**Malicious release:** If an advisory, diff or trust check indicates a malicious
or compromised package, stop all builds/installs immediately and report to the
user.

**Non-interactive runs:** If the user is unavailable to answer, complete the
independent work, leave blocked items untouched, and place the blocking
questions at the top of the report.

## Commit subjects

The repository's own commit history takes precedence (per the `commit` skill).
Otherwise use these subjects (`v1.NN`, `<name>` and `<major>` are placeholders):

| Change                                    | Subject                                                         |
| ----------------------------------------- | --------------------------------------------------------------- |
| MSRV bump (breaking change)               | `build!: bump MSRV to v1.NN`                                    |
| Lints enabled by the MSRV bump            | `style(clippy): fix warnings enabled by the MSRV bump`          |
| Rust dependencies within declared ranges  | `build(deps): upgrade semver compatible Rust dependencies`      |
| Node dependencies within declared ranges  | `build(deps): upgrade semver compatible Node dependencies`      |
| Single major upgrade                      | `build(deps): upgrade <name> to v<major>`                       |
| Version younger than a day (security fix) | `build(deps): upgrade <name> to v<version>`                     |
| Coupled major upgrades                    | `build(deps): upgrade <a> and <b> to v<major>`                  |
| Family of coupled crates                  | `build(deps): upgrade RustCrypto dependencies`                  |
| Ignore an inapplicable advisory           | `build(deps): ignore RUSTSEC-YYYY-NNNN`                         |
| Allow a license in `deny.toml`            | `build(deps): allow the <license> license`                      |
| Pinned Rust toolchain in CI               | `chore(ci): upgrade Rust to v1.NN.P`                            |
| Single pinned action                      | `chore(ci): upgrade actions/checkout to v7.0.1`                 |
| Routine refresh of pinned actions         | `chore(ci): upgrade the pinned actions`                         |
| Runner image                              | `chore(ci): run on Ubuntu 26.04`                                |
| Toolchains in `Actions/ci-images`         | `ci: bump Rust to 1.NN.P, Node.js to 24.X.Y and pnpm to 12.X.Y` |

- `<major>` is the compatibility-defining prefix: `v0.23` for `0.23.x`, `v2`
  for `2.x`.
- Mark a major upgrade with `!` (`build(deps)!: ...`) and explain what breaks
  in the body when the project publishes a library to crates.io or npm and the
  upgraded dependency is part of its public API (re-exported, or used in public
  types/traits). Unpublished crates (`publish = false`, `"private": true`) and
  binaries do not take `!`.
- Check `git log -- .github .forgejo` for whether the repository uses `ci:` or
  `chore(ci):`.
- Write prose commit bodies wrapped at 72 columns that explain _why_ and _what
  changed for us_ (`references/changelogs.md`), rather than listing version
  numbers already visible in the lockfile diff.

## Report

End the run with a report covering:

- commits created since `<base>`: short hash, subject and a one-line summary;
- decisions waiting on the user, with the gathered evidence;
- crates flagged as unmaintained, with the alternatives the advisory lists
  (replacing one is the user's call);
- items deliberately left unchanged: skipped majors, ignored advisories, active
  release-age exceptions, versions held back by the MSRV, and standing holds
  (`[patch]`, `=` pins, overrides), each with its reason;
- CI gaps noticed during the run, even when no CI audit was requested (for
  example, no MSRV job for a library published to crates.io or npm, or
  `cargo-deny` run without `--workspace`);
- new duplicate crate versions introduced by the run, the offending crates, and
  each offender's upstream status;
- in our repositories: drift aligned with siblings, and any sibling repositories
  that need a shared fix made here;
- upstream APIs worth adopting in a follow-up.
