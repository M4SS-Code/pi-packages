---
name: repo-maintenance
license: MIT
description: >
  Maintain repository dependencies and CI for Rust (Cargo) and Node.js (pnpm).
  Use when asked to update, upgrade or bump dependencies, handle RustSec or npm
  security advisories, bump the MSRV, audit or refresh GitHub Actions and
  Forgejo Actions workflows, or upgrade the Alpine, Debian, Rust, Node.js,
  database and other container images in Containerfiles, Dockerfiles and
  Compose files.
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
| Container images in Containerfiles and Compose files  | `references/containers.md` |

Paths are relative to this skill's directory. Inspect `Cargo.lock`,
`pnpm-lock.yaml`, `.github/workflows/`, `.forgejo/workflows/`,
`.gitlab-ci.yml`, the Containerfiles (including `Dockerfile`s) and the Compose
files to see which procedures apply. When you bump the Rust toolchain in CI,
also bump the Rust images in the Containerfiles. For a Rust workspace with a
SvelteKit frontend, run both dependency procedures in sequence (run pnpm from
the directory containing `pnpm-lock.yaml`). Review every major upgrade with
`references/changelogs.md`.

Run the CI audit when asked, or propose it when the workflows haven't changed in
months (`git log -1 --format=%cs -- .github .forgejo .gitlab-ci.yml`).

## Our repositories

A repository is **ours** when all of the following hold:

1. Any remote in `git remote -v` is on `code.m4ss.net` or under
   `github.com/M4SS-Code` (SSH form `git@github.com:M4SS-Code/...`).
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
  commit grouping, subjects and required checks. If it is not available, stop
  and ask before the first commit. Never run `git push`, and never bypass hooks
  (`git commit --no-verify`).
- Record the starting commit (`git rev-parse HEAD`, called `<base>` below),
  check `git status --short` (stop and ask if files the run will touch are
  already dirty), and create a temporary directory outside the repository
  (`mktemp -d`, called `<scratch>` below). Each command may run in a new shell,
  so a variable does not survive: copy the path that `mktemp -d` prints
  literally into later commands, and never save it to a file. Put every
  temporary file in `<scratch>`: baselines, lockfile copies, build logs, test
  projects, downloaded and extracted packages (`tar -xzf <file> -C <scratch>`),
  cloned upstream repositories and `git worktree` checkouts. Never create other
  paths in `/tmp`. Before each commit, check `git status --short` for untracked
  files the run created (extracted crates, tool state such as `.pi/`): move them
  to `<scratch>` or leave them out, and never commit them. At the end of the
  run, remove any worktrees (`git worktree remove`) and then `<scratch>`.
- Treat code in releases under review as untrusted: read it, and never build,
  test, install or execute anything from it before review.
- Never run `git log -S`, `-G` or `-p` over a whole history, in the
  repository or in an upstream clone: on a large history it can run for many
  minutes, and in a clone made with `--filter` it also downloads the missing
  blobs one request at a time. In an upstream clone, limit it to a range
  (`<old-sha>..<new-sha>`) and a path, or search the published package files
  instead. In the repository being maintained, a path is enough
  (`git log -S'<text>' -- Cargo.toml`).
- Use `curl` against `https://api.github.com/...` or
  `raw.githubusercontent.com` for read-only GitHub queries instead of `gh`.
  Pass `-H "Authorization: Bearer ${GITHUB_TOKEN:-$GH_TOKEN}"` only when
  either token is set; with neither set, leave the header out entirely,
  because an empty `Bearer` makes GitHub answer 401 even for public data.
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
- a compatible release fixes an advisory affecting a locked version, or its
  changelog mentions a security fix;
- a release that ships the lockfile (a binary, container image or deployed app,
  not a library) is about to be cut; or
- the user explicitly asked for a compatible upgrade.

If none applies, ask before running the compatible upgrade, and still run the
advisory, MSRV and major-version checks.

## Security fixes and the release-age gate

The one-day release-age gate protects against compromised releases. It never
outranks a security fix: a fixed vulnerability that stays locked for a day is
the bigger risk. A release counts as a security fix when either:

- an advisory (RUSTSEC, GHSA, CVE) affecting a locked version names it as the
  fix; or
- its changelog, release notes or release commit says it fixes a security
  issue, even when no advisory exists yet. Advisories are often published days
  after the release.

For every release held back by the gate, read its changelog or release notes
(`references/changelogs.md`) to find these. Take a security fix right away,
without waiting for the gate or asking, after auditing its release diff. When
there is no advisory, the changelog rarely says enough to judge whether the
issue affects us: assume it does, and quote the changelog line in the commit
body instead of an advisory ID.

## Stop and ask

Gather the evidence first, then stop and ask the user when:

- a newer version is held back by the MSRV;
- an applicable advisory has no fix, or its fix requires an override, MSRV bump
  or upstream release;
- an update introduces an unallowed license, or an install script that must run
  (disabling an unneeded install script does not require approval);
- a version younger than the one-day release-age gate is needed for anything
  other than an audited security fix ("Security fixes and the release-age
  gate");
- a major upgrade requires a large migration, or upgrades conflict;
- a workflow in one of our repositories needs an action not yet mirrored on
  `code.m4ss.net`;
- aligning a repository with siblings would drop an existing check;
- the repository loads code from a CDN at build or run time (an `import` or
  `<script src>` from jsDelivr, unpkg or esm.sh, or the URLs under `modules` in
  `project.inlang/settings.json`). That code skips the lockfile and the
  release-age gate: report each URL and the version it loads, and ask before
  changing it;
- any action would push, publish or delete.

**Malicious release:** If an advisory, diff or trust check indicates a malicious
or compromised package, stop all builds/installs immediately and report to the
user.

**Non-interactive runs:** If the user is unavailable to answer, complete the
independent work, leave blocked items untouched, and place the blocking
questions at the top of the report.

## Commit subjects

The repository's own commit history takes precedence (per the `commit` skill).
Otherwise use these subjects. Anything in `<>`, and `NN`, `N`, `P`, `X.Y`
and `YYYY`, is a placeholder to fill in. Rows with concrete names (an action,
an image, a version, `RustCrypto`) are examples: keep the shape and put in the
names and versions of the actual change.

| Change                                    | Subject                                                         |
| ----------------------------------------- | --------------------------------------------------------------- |
| MSRV bump, library published to crates.io | `build!: bump MSRV to v1.NN`                                    |
| MSRV bump, binary-only or unpublished     | `build: bump MSRV to v1.NN`                                     |
| Lints enabled by the MSRV bump            | `style(clippy): fix warnings enabled by the MSRV bump`          |
| Rust dependencies within declared ranges  | `build(deps): upgrade semver compatible Rust dependencies`      |
| Node dependencies within declared ranges  | `build(deps): upgrade semver compatible Node dependencies`      |
| Single major upgrade                      | `build(deps): upgrade <name> to v<major>`                       |
| Version younger than a day (security fix) | `build(deps): upgrade <name> to v<version>`                     |
| Coupled major upgrades                    | `build(deps): upgrade <a> and <b> to v<major>`                  |
| Family of coupled crates                  | `build(deps): upgrade RustCrypto dependencies`                  |
| Ignore an inapplicable advisory           | `build(deps): ignore RUSTSEC-YYYY-NNNN`                         |
| Allow a license in `deny.toml`            | `build(deps): allow the <license> license`                      |
| `deny.toml` targets fixed to match CI     | `build(deps): check the targets CI builds in cargo-deny`        |
| Pinned Rust toolchain in CI               | `chore(ci): upgrade Rust to v1.NN.P`                            |
| Single pinned action                      | `chore(ci): upgrade actions/checkout to v7.0.1`                 |
| Routine refresh of pinned actions         | `chore(ci): upgrade the pinned actions`                         |
| Runner image                              | `chore(ci): run on Ubuntu 26.04`                                |
| Full image names in a Containerfile       | `build(docker): use fully qualified image names`                |
| Floating image tag pinned, same digest    | `build(docker): pin Postgres to v19.0`                          |
| Rust image in a Containerfile             | `build(docker): upgrade Rust to v1.NN`                          |
| Alpine image, with the Rust in its tag    | `build(docker): upgrade Alpine Linux to v3.NN / Rust to v1.NN`  |
| Debian image                              | `build(docker): upgrade Debian to Trixie`                       |
| Node.js or another image                  | `build(docker): upgrade Node.js to v26`                         |
| Toolchains in `Actions/ci-images`         | `ci: bump Rust to 1.NN.P, Node.js to 24.X.Y and pnpm to 12.X.Y` |

- For `Actions/ci-images`, name only the toolchains that changed, in the order
  Rust, Node.js, Go, pnpm.
- `<major>` is the compatibility-defining prefix: `v0.23` for `0.23.x`, `v2`
  for `2.x`.
- Mark a major upgrade with `!` (`build(deps)!: ...`) and explain what breaks
  in the body when the project publishes a library to crates.io or npm and the
  upgraded dependency is part of its public API (re-exported, or used in public
  types/traits). Unpublished crates (`publish = false`, `"private": true`) and
  binary-only crates do not take `!`, for major upgrades or MSRV bumps. For dependency
  upgrades and MSRV bumps, this rule decides what counts as breaking, over the
  `commit` skill's general `!` rule.
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
