# CI audit

Run it when asked, or propose it for a repository whose workflows haven't
changed in months (`git log -1 --format=%cs -- .github .forgejo .gitlab-ci.yml`).
This file covers what applies everywhere, plus GitHub Actions specifics;
`references/forgejo.md` covers Forgejo Actions, and code.m4ss.net for our
repositories. In our repositories, the reference for how things should look
is whatever is newest across all of them ("Keeping our repositories alike"
below), not any one repository.

Fix what's wrong and propose what's a matter of taste. Make one commit per
concern. The body says what was wrong, or for a hardening pass what it
changes, for example:

```text
chore(ci): harden CI workflow

Restrict the token to read access, pin actions to verified commit SHAs
and check out without persisted credentials. Add a concurrency group
and per-job timeouts.
```

```text
chore(ci): keep testing the other platforms when one fails

A failure on one platform cancelled the test jobs of the others, so
it wasn't known whether they passed.
```

## Checklist

### Triggers and runs

- Propose (do not change unasked) restricting `push` to `main` when
  `pull_request` is present (`on:` with `pull_request`, and `push` restricted
  to `main`): with `push` on every branch plus `pull_request`, every push to
  a pull request's branch runs CI twice, though some repositories want CI on
  branches without a pull request.
- A concurrency group cancelling superseded runs:
  `group: ${{ github.workflow }}-${{ github.ref }}` with
  `cancel-in-progress: true`.
- `timeout-minutes` on every job.
- `fail-fast: false` on platform matrices, so one platform's failure doesn't
  hide the others' results.
- `pull_request_target`, `workflow_run` and `issue_comment` run with secrets
  on code or input from outside: flag them.

### Token and credentials

- Top-level `permissions: contents: read`. A job that needs more gets it on
  that job (or the workflow, when every job needs it) with a comment saying
  why, like `id-token: write` for npm trusted publishing.
- `persist-credentials: false` on `actions/checkout`, unless a later step
  pushes with the job's token.
- Secrets passed one by one (`secrets.FOO`), never `secrets: inherit` or
  `toJSON(secrets)`.
- No `${{ }}` expansion of values others control (pull request titles, branch
  names, issue bodies) inside `run:`; pass them through `env:` instead.

### Pinning

- Every `uses:` pinned to a full commit SHA, with the version in a comment:
  the most specific version tag pointing at that commit (`# v7.0.1` rather
  than `# v7`, `# v2.90.1` rather than `# v2`). Only an action used from a
  branch, because it publishes no releases to pin, gets the branch
  (`dtolnay/rust-toolchain@<sha> # master`).
- Existing pins verified, not just well-formed. The SHA must be the commit
  the comment names: resolve the tag (section "Refreshing pinned actions",
  step 2) and compare. A tag object's SHA in place of its commit, or twins in
  `.github/` and `.forgejo/` pinning the same version to different SHAs, are
  findings. For a branch pin, check that the branch contains the commit. On
  GitHub, mere existence proves nothing, since commits from forks resolve
  too:
  `curl -sS https://api.github.com/repos/<owner>/<repo>/compare/<sha>...<branch> | jq -r .status`
  must say `ahead` or `identical`. In our repositories' Forgejo workflows,
  the code.m4ss.net mirror only holds upstream's own commits, so there
  existence is enough:
  `curl -sS -o /dev/null -w '%{http_code}' https://code.m4ss.net/api/v1/repos/Actions/<repo>/git/commits/<sha>`
  (200 or 404).
- Tools installed by actions or scripts pinned to a version
  (`tool: cargo-hack@0.6.39`). Downloads use `curl -fsSL`: without `-f`,
  curl saves an error page as the binary and the step succeeds. Verify a
  checksum where the project publishes one.
- Container images (`container:`, `services:`, `docker run`) pinned by
  digest: `image:tag@sha256:...`, or `image@sha256:... # tag`.
- Pinned Rust toolchains are current: stable and beta the latest ones, a
  nightly not too old (see "Toolchains").

### Runners

- Every runner label names an OS version, never a `-latest` label:
  `ubuntu-latest`, `macos-latest` and `windows-latest` move to a new release
  whenever GitHub decides, changing what CI runs on without a commit in the
  repository. Use the newest version of each: at the time of writing
  `ubuntu-26.04`, `macos-26` and `windows-2025`. GitHub lists its labels in
  the README of `actions/runner-images`; a "preview" badge there is no reason
  to wait.
- Ask before moving a job that builds release binaries off an older Ubuntu.
  Binaries need at least the glibc they were built against, and at the time
  of writing the target is Debian 13 "trixie", with glibc 2.41: Ubuntu 24.04
  has 2.39, so what it builds runs there, while Ubuntu 26.04 has 2.43, so
  what it builds doesn't. Revisit the choice once Debian 14 "forky" is the
  stable release.

### What the jobs run

- `--locked` on every cargo command that builds or tests, and
  `pnpm install --frozen-lockfile`.
- clippy over `--all-targets` and the feature combinations that matter; an
  MSRV job testing with the `rust-version` toolchain.
- cargo-deny when the repository has a `deny.toml`.
- Node.js versions in the matrix are all maintained releases (the schedule
  is in the `nodejs/Release` repository): drop end-of-life ones, add the new
  LTS.

### Publishing

- Everything that isn't meant to be published says so, so that a stray
  `cargo publish` or `pnpm publish -r` can't release it: `publish = false`
  in its `Cargo.toml` (or `publish.workspace = true`, with the setting in
  `[workspace.package]`), `"private": true` in its `package.json`. The usual
  candidates are examples, test harnesses and internal tools in a workspace,
  the root `package.json` of a pnpm workspace, and applications that get
  deployed rather than published, like a SvelteKit app or a server binary.
  cargo-deny relies on the marker too: `[licenses.private] ignore = true`
  only skips the license check for unpublished crates.
- Compare what's marked with what's on the registries:

  ```sh
  cargo metadata --no-deps --format-version 1 | jq -r '.packages[] | [.name, (.publish | tostring)] | @tsv'   # [] is publish = false
  git ls-files '*package.json' | while read -r f; do jq -r --arg f "$f" '[$f, .name, (.private // false)] | @tsv' "$f"; done
  cargo info -q <crate> --registry crates-io | grep '^repository:'
  npm view <name> repository.url
  ```

  A name on the registry isn't necessarily ours: its repository has to be
  this one. Something that's neither marked nor published from this
  repository is probably missing its marker; ask before adding it, since it
  may be about to get its first release. The commit is `build:`, saying what
  it keeps from being published.

- Published crates leave CI files out of the package:
  `exclude = [".github/", ".forgejo/", "deny.toml"]`. `cargo package --list`
  shows what ships.

### Other CI

- A `.gitlab-ci.yml` in one of our repositories (SKILL.md, "Our
  repositories"): ours moved from GitLab CI to Forgejo Actions. Point it out
  and ask.
- `.github/dependabot.yml` with the `github-actions` ecosystem already opens
  pull requests bumping the pins. Check for open ones before bumping by hand,
  and remember that dependabot only touches `.github/`: the Forgejo twins
  need the same bump by hand.

### Tools

- `zizmor --pedantic .github/workflows` checks most of the above
  (`unpinned-uses`, `unpinned-images`, `excessive-permissions`, `artipacked`,
  `ref-version-mismatch`, `template-injection`, `cache-poisoning`, ...). With
  `GH_TOKEN` set it also runs its online audits, like `impostor-commit` and
  `known-vulnerable-actions`. If it's missing, `uvx zizmor`,
  `pipx run zizmor` or `cargo install --locked zizmor`. It doesn't know about
  Forgejo.
- `actionlint` catches syntax and expression errors in GitHub workflows.
- In a pnpm repository, `pnpm outdated --include-github-actions` lists
  outdated actions in `.github/workflows/`, and
  `pnpm update --include-github-actions` re-pins them to a commit with the
  tag in a comment. Check its result like a manual bump.

## Refreshing pinned actions

Every couple of months, and sooner for a security fix or a breakage. See when
it last happened:
`git log -5 --format='%cs %s' -G'@[0-9a-f]{40}' -- .github .forgejo`.

For each action:

1. Find the newest release. The filter keeps full version tags only, skipping
   moving major tags (`v7`) and non-version tags (taiki-e/install-action has
   one per tool):
   `git ls-remote --tags --refs https://github.com/<owner>/<repo> | sed 's|.*refs/tags/||' | grep -E '^v?[0-9]+(\.[0-9]+)+$' | sort -V | tail -3`.
2. Resolve its commit against the action's own repository, never a fork or a
   web page; that's what makes the SHA verified:
   `git ls-remote https://github.com/<owner>/<repo> 'refs/tags/<tag>' 'refs/tags/<tag>^{}'`.
   For an annotated tag, the `^{}` line is the commit: pin that one, not the
   tag object.
3. Read the release notes from the pinned version on. Majors can drop inputs,
   change defaults or move to a newer Node.js runtime that older runners
   can't run.
4. Replace every occurrence with the new SHA and comment, in
   `.github/workflows/` and `.forgejo/workflows/` alike. In our repositories,
   the code.m4ss.net mirror must have the commit (`references/forgejo.md`).
5. An action pinned to a branch commit (`# main`) may be waiting for a
   release with a fix. If a release now contains the commit
   (`git merge-base --is-ancestor <sha> <tag>` in a clone), move to it.

Commit a single action as `chore(ci): upgrade actions/checkout to v7.0.1`,
and a routine refresh of several as `chore(ci): upgrade the pinned actions`.
The version comments in the diff already show what moved, so the body only
says what matters: a security fix, a new Node.js runtime, a changed default.
A major upgrade that needed workflow changes gets its own commit.

## Toolchains

CI may pin any of the Rust channels. Compare each pin with what the channel
ships now:

```sh
for c in stable beta nightly; do
  curl -sSf "https://static.rust-lang.org/dist/channel-rust-$c.toml" | awk '/^\[pkg\.rust\]/{getline; print}'
done
```

- **Stable** (`1.99.1`): the latest release.
- **Beta** (`beta-YYYY-MM-DD`, or a `1.NN.0-beta.N` version): the current
  beta. One from before the latest stable release belongs to a cycle that is
  over.
- **Nightly** (`nightly-YYYY-MM-DD`): it doesn't have to track every day; a
  few weeks old is fine. Bump it when it predates the latest stable release
  (about every six weeks), or sooner when something needs a newer one. Pick a
  date that has every component CI installs (clippy, rustfmt, miri, ...):
  `rustup toolchain install nightly-YYYY-MM-DD --profile minimal -c <component>`
  fails when one is missing.

To bump one:

1. `rustup toolchain install <new> --profile minimal -c clippy -c rustfmt`.
2. Run the CI commands that use that toolchain with `cargo +<new>`. Fix new
   warnings in a `style(clippy):` commit first, so that the bump never breaks
   CI.
3. Update the version everywhere it's spelled out: the `RUST_VERSION`-style
   variable, `toolchain:` inputs, job names (`clippy / 1.99.1`; a job's
   `name` can't read `env`, so it repeats the version) and cache keys.
4. Commit as `chore(ci): upgrade Rust to v1.NN.P`, or
   `chore(ci): upgrade Rust beta to ...` and
   `chore(ci): upgrade Rust nightly to YYYY-MM-DD`.

In our repositories, the code.m4ss.net runner images come with one stable
preinstalled. A workflow pinned to that version skips a download, so the
images and the repositories usually move together, but nothing requires it:
a job asking for another version gets it installed (`references/forgejo.md`).

## Keeping our repositories alike

In our repositories (SKILL.md, "Our repositories"), `deny.toml` and the CI
workflows follow a shared form, so that a fix made once applies everywhere and
nothing differs just because it happened to. Before changing either, and as
part of every audit:

1. Read the siblings' versions. The public repositories are under
   github.com/M4SS-Code, skipping forks
   (`curl -sS 'https://api.github.com/orgs/M4SS-Code/repos?type=sources&per_page=100&sort=pushed' | jq -r '.[] | [.name, .pushed_at, .language] | @tsv'`).
   On code.m4ss.net, almost all of our non-mirror repositories are private,
   so querying
   `https://code.m4ss.net/api/v1/repos/search?mode=source&sort=updated&order=desc&limit=50`
   only helps with a token (`-H "Authorization: token $FORGEJO_TOKEN"`): ask
   for one when private siblings matter. Fetch the files from
   `https://code.m4ss.net/Mirror/<repo>/raw/branch/main/<path>`,
   `https://raw.githubusercontent.com/M4SS-Code/<repo>/HEAD/<path>`,
   `https://code.m4ss.net/<owner>/<repo>/raw/branch/<branch>/<path>`, or with
   a shallow clone. Three or four recently maintained repositories of the
   same kind (a Rust library, a Rust binary, a pnpm app) are enough.
2. Work out the shared form: what they agree on and, where they differ, which
   way the most recently maintained ones went. The form evolves, and the
   newest changes show where it's heading.
3. Compare this repository with it, section by section:
   - `deny.toml`: the same sections and settings, in the same order and style.
     Only what follows from the dependencies differs: the licenses in
     `allow`, and advisory ignores with their reasons.
   - Workflows: the same triggers, concurrency, permissions, job and step
     names, layout, actions pinned to the same commits, toolchain pins. Only
     what the project needs differs: its feature combinations, services,
     extra jobs.
4. Bring what differs without a reason in line, one concern per commit like
   any other CI change. A difference with a reason (a comment, a commit
   explaining it, a release build on an older Ubuntu) stays.
5. When the comparison shows that the shared form itself needs fixing (a
   missing hardening, a stale pin, a setting that's better another way), fix
   it here and list in the report every sibling that needs the same change,
   so that it gets rolled out everywhere instead of making this repository
   the odd one out. If the user asks, apply it to each of them the same way.
