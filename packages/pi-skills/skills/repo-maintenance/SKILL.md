---
name: repo-maintenance
license: MIT
description: >
  Maintain a repository's dependencies and CI. Use when asked to update,
  upgrade or bump dependencies, handle RustSec or npm security advisories,
  bump the MSRV, or audit or refresh CI. Covers Rust (Cargo) and Node.js
  (pnpm, often SvelteKit) projects: semver-compatible and major upgrades
  reviewed against changelogs and the published release diffs, versions held
  back by the MSRV, pnpm's one-day release-age gate, duplicate crate versions,
  and GitHub Actions and Forgejo Actions workflows (pinned actions, token
  permissions, runner images and toolchains), including keeping the M4SS
  repositories' deny.toml and CI alike and their code.m4ss.net runners.
---

# Repository maintenance

Keep dependencies current and CI sound without letting anything unreviewed
in. The result is a series of small local commits, each easy to review, revert
and bisect, and a report of what still needs a decision.

## Pick the procedure

| Task                                                  | Read                       |
| ----------------------------------------------------- | -------------------------- |
| Rust dependencies, the MSRV, RustSec advisories       | `references/rust.md`       |
| Node.js dependencies with pnpm, npm advisories        | `references/node.md`       |
| Reviewing an upgrade: changelog and release diff      | `references/changelogs.md` |
| Auditing CI, refreshing pinned actions and toolchains | `references/ci-audit.md`   |
| Forgejo Actions, and our code.m4ss.net runners        | `references/forgejo.md`    |

Paths are relative to this skill's directory. Find out what the repository
has from `Cargo.lock`, `pnpm-lock.yaml`, `.github/workflows/`,
`.forgejo/workflows/` and `.gitlab-ci.yml`. A Rust workspace with a SvelteKit
frontend needs both dependency procedures, one after the other; run pnpm from
the directory that holds `pnpm-lock.yaml`. Every major upgrade, in either
ecosystem, goes through `references/changelogs.md`.

Dependency maintenance is the usual job. The CI audit runs when asked; propose
it when the repository's workflows haven't changed in months.

## Our repositories

A repository is ours when its remote is on code.m4ss.net or under
github.com/M4SS-Code (`git remote -v`), and it isn't a mirror or fork of an
upstream project (`Mirror/<repo>` on code.m4ss.net when `original_url` isn't
under `M4SS-Code`, the action mirrors under `Actions/` other than
`Actions/ci-images`, or a fork under `M4SS-Code`). Two rules follow from
that:

- **Ours stay alike.** Their `deny.toml` and CI configs follow the form the
  other repositories share instead of growing variants of their own. Before
  changing either, look at how the siblings do it
  (`references/ci-audit.md`, "Keeping our repositories alike"), and bring a
  repository that drifted back in line. When the shared form itself needs a
  fix, fix it here and list every other repository that needs the same
  change, so that it ends up fixed everywhere and not just here.
- **Only ours use code.m4ss.net.** Its mirrors, runner images and conventions
  (`references/forgejo.md`) are for our repositories. Anyone else's
  repository never gets a reference to code.m4ss.net, whatever forge it's on.

## Ground rules

- Load the `commit` skill before the first commit. It owns staging, the
  message format and folding corrections into earlier commits; this skill
  decides what goes in each commit, its subject and which checks it needs.
  Nothing gets pushed.
- Note the starting commit (`git rev-parse HEAD`, `<base>` below), check
  `git status --short` (stop and ask if files the run will touch are already
  dirty), and create a scratch directory outside the repository
  (`mktemp -d`, `<scratch>` below) for baselines.
- Treat the code of releases under review as untrusted: read it, never
  build, test, install or run anything from it.
- Read-only GitHub queries use `curl` against its REST API
  (`https://api.github.com/...`) or `raw.githubusercontent.com`, not the
  GitHub CLI, which isn't always installed. Unauthenticated requests are
  enough (60 an hour); add
  `-H "Authorization: Bearer ${GITHUB_TOKEN:-$GH_TOKEN}"` when either token
  is set.
- Verify with the commands the repository's CI runs, with `--locked` or
  `--frozen-lockfile`, not with a guess at them. Each commit gets the ones
  that cover what it changes: build, clippy and tests across CI's feature
  combinations, the MSRV job, cargo-deny; or pnpm's `check`, `lint`, `test`
  and `build`. Run the full set once at the end. Jobs that can't run locally
  (external services, hour-long feature powersets, coverage uploads) go in
  the report, for CI to cover.
- When a check fails and the procedure here says how to handle it (a
  regressed compatible release, new lints), do that. Otherwise the `commit`
  skill's rule applies: keep the failure visible and ask.
- Look up versions, release dates, runner labels and advisories every time.
  They change daily, and anything remembered is stale. "At the time of
  writing" in these files means November 2026: re-check such statements
  before relying on them.

## When to upgrade within the declared ranges

Upgrading every dependency within its declared range is routine and happens
every few weeks. The lockfile's history shows when it last happened:
`git log -10 --format='%cs %s' -- '*Cargo.lock' '*pnpm-lock.yaml'`. It's due
when:

- the last one is more than a few weeks old;
- an advisory affecting a locked version is fixed by a compatible release; or
- a release that ships the lockfile is about to be cut (a binary, a container
  image, a deployed app), even if the last upgrade was days ago. A library has
  no such trigger: its lockfile never reaches its users.

When none of these applies and the request didn't ask for a compatible upgrade
outright, say so and ask before running it; the advisory, MSRV and
major-version checks run regardless.

## Stop and ask

Gather the evidence, then ask rather than decide when:

- a newer version is held back by the MSRV;
- an advisory affects us and has no fix, or the fix needs an override, an MSRV
  bump or an upstream release;
- an advisory is about an unmaintained crate, which only replacing it fixes;
- an update brings a license the project doesn't allow yet, or an install
  script that has to run (blocking one that isn't needed is fine);
- a version younger than the one-day release-age gate seems necessary for
  anything other than a security fix that affects us (security fixes are taken
  after auditing their diff);
- a major upgrade needs a large migration, or upgrades conflict;
- the CI of one of our repositories needs an action that isn't mirrored on
  code.m4ss.net;
- bringing a repository in line with the others would stop it from checking
  something it checks today;
- anything would be pushed, published or deleted.

If an advisory, a diff or a trust check suggests that a release is malicious,
stop all work that would build or install it and report at once.

When nobody is there to answer, finish what doesn't depend on the answer,
leave the rest undone and put the questions at the top of the report. For
the MSRV question, `references/rust.md` says how to carry on.

## Commit subjects

The `commit` skill's precedence still applies: the repository's own history
wins. These are the subjects our repositories use; `v1.NN`, `<name>` and
`<major>` are placeholders.

| Change                                      | Subject                                                    |
| ------------------------------------------- | ---------------------------------------------------------- |
| MSRV bump (a breaking change)               | `build!: bump MSRV to v1.NN`                               |
| Lints the MSRV bump enabled                 | `style(clippy): fix warnings enabled by the MSRV bump`     |
| Rust dependencies within their ranges       | `build(deps): upgrade semver compatible Rust dependencies` |
| Node dependencies within their ranges       | `build(deps): upgrade semver compatible Node dependencies` |
| One major upgrade                           | `build(deps): upgrade <name> to v<major>`                  |
| A version younger than a day (security fix) | `build(deps): upgrade <name> to v<version>`                |
| Coupled major upgrades                      | `build(deps): upgrade <a> and <b> to v<major>`             |
| A family of coupled crates                  | `build(deps): upgrade RustCrypto dependencies`             |
| Ignoring an advisory that doesn't affect us | `build(deps): ignore RUSTSEC-YYYY-NNNN`                    |
| Pinned Rust toolchain in CI                 | `chore(ci): upgrade Rust to v1.NN.P`                       |
| One pinned action                           | `chore(ci): upgrade actions/checkout to v7.0.1`            |
| Routine refresh of the pinned actions       | `chore(ci): upgrade the pinned actions`                    |
| Runner image                                | `chore(ci): run on Ubuntu 26.04`                           |
| Toolchains in `Actions/ci-images`           | `ci: bump Rust to 1.NN.P and pnpm to 12.X.Y`               |

`<major>` is the part that decides compatibility: `v0.23` for `0.23.x`, `v2`
for `2.x`. A major upgrade becomes `build(deps)!:` when the project
publishes a library (to crates.io or npm) and the dependency is part of its
public API. Some repositories write CI commits as `ci:` instead of
`chore(ci):`; check `git log -- .github .forgejo`.

Bodies explain; they don't list. The lockfile diff already shows every
version. Say why the MSRV moved, which advisories or yanked versions an
upgrade fixes, what a major upgrade changed for us (see
`references/changelogs.md`) and, for CI, the problem before the fix. Wrap at
72 columns.

## Report

Finish with:

- the commits since `<base>`: short hash, subject and one line each;
- decisions waiting on the user, with the evidence;
- what was deliberately left alone: skipped majors, ignored advisories,
  release-age exceptions in place, versions held back by the MSRV, and the
  other holds that stay (`[patch]`, `=` pins, overrides), each with its
  reason;
- duplicate versions the work introduced, their offenders and the upstream
  status of each;
- in our repositories, where this one differed from the shared form and what
  was aligned, and the other repositories that need a fix made here;
- upstream APIs worth adopting later.
