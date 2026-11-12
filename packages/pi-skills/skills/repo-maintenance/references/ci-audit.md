# CI audit

This file covers general CI rules and GitHub Actions. Forgejo Actions and
`code.m4ss.net` are in `references/forgejo.md`.

Fix clear issues directly (one commit per concern) and propose changes that
are a matter of preference. Write commit bodies that state what was wrong or
what a hardening pass changed:

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

- **Duplicate branch runs**: When `pull_request` is present and `push` is
  unrestricted, propose (do not change unasked) restricting `push` to `main` so
  PR branch pushes do not run CI twice.
- **Concurrency**: Cancel superseded runs with
  `group: ${{ github.workflow }}-${{ github.ref }}` and
  `cancel-in-progress: true`.
- **Timeouts**: Set `timeout-minutes` on every job.
- **Matrix `fail-fast`**: Set `fail-fast: false` on platform matrices so one
  platform failure does not cancel the others.
- **Privileged triggers**: Flag `pull_request_target`, `workflow_run` and
  `issue_comment` triggers that run with secrets on untrusted code or input.

### Token and credentials

- **Permissions**: Set top-level `permissions: contents: read`. Grant broader
  permissions only per-job (or workflow-wide if every job requires it) with a
  comment explaining why (e.g., `id-token: write` for npm trusted publishing).
- **Checkout credentials**: Set `persist-credentials: false` on
  `actions/checkout` unless a subsequent step pushes using the job token.
- **Secrets**: Pass secrets individually (`secrets.FOO`), never with
  `secrets: inherit` or `toJSON(secrets)`.
- **Script injection**: Never interpolate untrusted context values (PR titles,
  branch names, issue bodies) via `${{ }}` inside `run:`; pass them through
  `env:` variables instead.

### Pinning

- **Actions**: Pin every `uses:` to a full 40-character commit SHA followed by
  a comment with the most specific release tag (`# v7.0.1`, not `# v7`), or the
  branch name if the action makes no releases (`dtolnay/rust-toolchain@<sha> # master`).
- **Verify existing action pins**: Resolve each tag (see "Refreshing pinned
  actions", step 2) and confirm the pinned SHA is the dereferenced commit and is
  the same in `.github/` and `.forgejo/` twins. For branch pins on GitHub, verify the commit belongs to the upstream
  branch rather than a fork:
  `curl -sS https://api.github.com/repos/<owner>/<repo>/compare/<sha>...<branch> | jq -r .status`
  must return `ahead` or `identical`. On `code.m4ss.net`, mirrors only hold
  upstream commits, so checking HTTP 200 is sufficient:
  `curl -sS -o /dev/null -w '%{http_code}' https://code.m4ss.net/api/v1/repos/Actions/<repo>/git/commits/<sha>`.
- **Installed tools**: Pin tool versions (`tool: cargo-hack@0.6.39`). Use
  `curl -fsSL` for downloads (without `-f`, HTTP error pages are saved as 0-exit
  files) and verify checksums when published.
- **Downloaded tools**: Cache every binary or archive a workflow downloads
  with `curl`, so CI does not fetch it from an external service on every run
  and keeps working during that service's downtime while the cache is warm:
  1. Put the version and its SHA256 together in `env:`, with a comment saying
     where the checksum comes from.
  2. Restore the file with the cache action (`actions/cache` on GitHub,
     `Actions/cache` on `code.m4ss.net`), with the version in the `key`.
  3. Run `curl -fsSL` only when the file is missing, then always check it with
     `sha256sum -c`, whether it came from the cache or the network.

  When bumping the version, update the SHA256 in the same commit. Example:

  ```yaml
  env:
    NIX_INSTALLER_VERSION: 2.35.3
    # sha256 of nix-installer-x86_64-linux, from the digest GitHub shows
    # for the release asset.
    NIX_INSTALLER_SHA256: 59a1841db7d41d5127163cc8acad45a04b0d73e95a022269d4b9e7ae2ad7fab2
  steps:
    - name: Cache nix-installer
      uses: https://code.m4ss.net/Actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
      with:
        path: /tmp/nix-installer
        key: nix-installer-x86_64-linux-${{ env.NIX_INSTALLER_VERSION }}
    - name: Install Nix
      run: |
        if [ ! -f /tmp/nix-installer ]; then
          curl -fsSL -o /tmp/nix-installer "https://github.com/NixOS/nix-installer/releases/download/${NIX_INSTALLER_VERSION}/nix-installer-x86_64-linux"
        fi
        echo "${NIX_INSTALLER_SHA256}  /tmp/nix-installer" | sha256sum -c -
  ```

- **Containers**: Pin `container:`, `services:` and `docker run` images by
  digest (`image:tag@sha256:...` or `image@sha256:... # tag`).
- **Rust toolchains**: Pin the Rust version (see "Toolchains").

### Runners

- Pin explicit OS versions (`ubuntu-26.04`, `macos-26`, `windows-2025` at the
  time of writing; check the `actions/runner-images` README for current
  labels). Never use moving `-latest` labels (`ubuntu-latest`, `macos-latest`,
  `windows-latest`).
- **Ask before upgrading Ubuntu on jobs that build release binaries:** Linux
  binaries require at least the build host's glibc at runtime. At the time of
  writing, targeting Debian 13 "trixie" (glibc 2.41) requires staying on
  `ubuntu-24.04` (glibc 2.39) rather than `ubuntu-26.04` (glibc 2.43) until
  Debian 14 "forky" is stable.

### What the jobs run

- Pass `--locked` to every Cargo build/test command and `--frozen-lockfile` to
  `pnpm install`.
- Run `clippy` with `--all-targets` and relevant feature combinations on the
  pinned Rust toolchain (see "Toolchains"). Crates published to crates.io also
  need an MSRV job with the `rust-version` toolchain; binaries and unpublished
  crates do not.
- Run `cargo-deny` when `deny.toml` exists, and verify `[graph] targets` in
  `deny.toml`:
  - Library: omit `targets` so `cargo-deny` checks all targets.
  - Binary or container image: `targets` must match the exact target triples CI
    builds (from `--target <triple>`, `Dockerfile`s, or the builder image's own
    triple when `cargo build` runs without `--target`, e.g.
    `x86_64-unknown-linux-musl` on `amd64` Alpine). Watch for stale `-musl` or
    `aarch64` triples after CI changes. If `deny.toml` is updated, re-run
    `cargo deny --workspace --all-features check` to catch newly exposed
    advisories/licenses or unused `allow`/`ignore` entries.
- Keep Node.js matrix versions aligned with maintained releases from
  `nodejs/Release` (drop EOL majors, add new LTS).
- Give every job or matrix entry that caches build outputs (such as Cargo's
  `target/`) its own `actions/cache` `key`, built from the job or build
  profile, toolchain, runner OS/arch or target triple, and matrix dimensions
  plus `hashFiles('Cargo.lock')`. With a shared key, one job either cannot
  save its cache or overwrites it with another build's output. Common
  collisions: `test` and a release `build` on different Ubuntu versions, a
  `live` job and `test`, and an `msrv` job whose key uses
  `${{ env.RUST_VERSION }}`. Package-store caches (`setup-node` with
  `cache: pnpm`) may share a key.

### Publishing

- Mark every package or crate not meant for registry publication so a stray
  `cargo publish` or `pnpm publish -r` cannot release it:
  - Rust: `publish = false` in `Cargo.toml` (or `publish.workspace = true`).
    (`cargo-deny` also requires this marker for `[licenses.private] ignore = true`.)
  - Node.js: `"private": true` in `package.json` (including the workspace root,
    apps, examples and internal tools).
- Compare local manifests against the registries:

  ```sh
  cargo metadata --no-deps --format-version 1 | jq -r '.packages[] | [.name, (.publish | tostring)] | @tsv'   # [] means publish = false
  git ls-files '*package.json' | while read -r f; do jq -r --arg f "$f" '[$f, .name, (.private // false)] | @tsv' "$f"; done
  cargo info -q <crate> --registry crates-io | grep '^repository:'
  npm view <name> repository.url
  ```

  Verify the registry entry's `repository` URL points to this repository (not
  an unrelated package with the same name). If a crate or package is neither
  marked private nor published from this repository, ask before adding the
  marker (in case a first release is planned), then commit as `build: ...`.

- In published Rust crates, exclude CI configs from the crate tarball
  (`exclude = [".github/", ".forgejo/", "deny.toml"]`; verify with
  `cargo package --list`).

### Other CI files and tools

- **`.gitlab-ci.yml` in our repositories**: Our repositories migrated from
  GitLab CI to Forgejo Actions; flag any leftover `.gitlab-ci.yml` and ask.
- **`.github/dependabot.yml`**: Check for open Dependabot PRs before bumping
  actions manually, and mirror any Dependabot action bumps into
  `.forgejo/workflows/` by hand.
- **Static analysis tools**:
  - Run `zizmor --pedantic .github/workflows` (set `GH_TOKEN` to enable online
    checks like `impostor-commit` and `known-vulnerable-actions`). Run it
    without installing via `uvx zizmor` or `pipx run zizmor`, or install it
    with `cargo install --locked zizmor`.
  - Run `actionlint` on `.github/workflows/`.
  - In pnpm workspaces, `pnpm outdated --include-github-actions` and
    `pnpm update --include-github-actions` list and update `.github/workflows/`
    action pins; still verify tags and commit SHAs as below.

## Refreshing pinned actions

Check when action pins were last updated:
`git log -5 --format='%cs %s' -G'@[0-9a-f]{40}' -- .github .forgejo`. Refresh
them every couple of months, or immediately for security fixes or breakages:

1. List the latest full version tags:
   `git ls-remote --tags --refs https://github.com/<owner>/<repo> | sed 's|.*refs/tags/||' | grep -E '^v?[0-9]+(\.[0-9]+)+$' | sort -V | tail -3`.
2. Resolve the tag's commit SHA directly from the upstream repository (for
   annotated tags, use the dereferenced `^{}` commit SHA, never the tag object
   SHA):
   `git ls-remote https://github.com/<owner>/<repo> 'refs/tags/<tag>' 'refs/tags/<tag>^{}'`.
3. Read the release notes between the old and new versions for breaking input,
   default or Node.js runtime changes.
4. Update the SHA and version comment across `.github/workflows/` and
   `.forgejo/workflows/` (after confirming the `code.m4ss.net` mirror has the
   commit; see `references/forgejo.md`).
5. If an action was pinned to an unreleased branch commit (`# main`), check
   whether a tagged release now includes that commit
   (`git merge-base --is-ancestor <sha> <tag>`) and switch to the release tag.

Use the subjects in `SKILL.md`, "Commit subjects", noting any security fixes, runtime changes or workflow adjustments in the body. Put major action
upgrades requiring workflow edits in their own commit.

## Toolchains

CI must pin the Rust version (`RUST_VERSION: 1.NN.P` in top-level `env:` and
`FROM rust:1.NN-...` in CI `Dockerfile`s) for `rustfmt`, `clippy`,
`cargo-hack`, `doc` and `build`, rather than using floating `stable`.

Verify every job that runs `cargo clippy` (dedicated `clippy` jobs, combined
`test` jobs, or cross-platform `build` jobs):

- It sets `toolchain: ${{ env.RUST_VERSION }}` on `dtolnay/rust-toolchain`
  (pinned to a `# master` commit), never `@stable`, `toolchain: stable`,
  `rustup update ... stable`, or an omitted `toolchain:` input.
- It sets `components: clippy` on `rust-toolchain` (required when
  `RUST_VERSION` differs from the runner image's preinstalled toolchain and
  installs with `--profile minimal`).
- Moving channel names (`stable`, `beta`, `nightly`) appear only in `test`
  matrices that run `cargo test` without `cargo clippy`.

Compare pinned toolchains against current upstream releases:

```sh
for c in stable beta nightly; do
  curl -sSf "https://static.rust-lang.org/dist/channel-rust-$c.toml" | awk '/^\[pkg\.rust\]/{getline; print}'
done
```

- **Stable** (`1.99.1`): Bump to the latest stable release.
- **Beta** (`beta-YYYY-MM-DD` or `1.NN.0-beta.N`): Bump if it predates the
  latest stable cycle.
- **Nightly** (`nightly-YYYY-MM-DD`): Bump when it predates the latest stable
  release (~6 weeks) or when needed sooner. Verify the target date includes all
  required components (`clippy`, `rustfmt`, `miri`, etc.) with:
  `rustup toolchain install nightly-YYYY-MM-DD --profile minimal -c <component>`.

To bump a pinned toolchain:

1. Install it locally:
   `rustup toolchain install <new> --profile minimal -c clippy -c rustfmt`.
2. Run CI's commands with `cargo +<new>`. If new clippy warnings appear, fix
   them first in a separate `style(clippy): ...` commit.
3. Update the version string everywhere it appears: `RUST_VERSION`,
   `toolchain:` inputs, job `name` strings (e.g., `clippy / 1.99.1`),
   `Dockerfile`s and cache keys.
4. Commit as `chore(ci): upgrade Rust to v1.NN.P` (or `... Rust beta to ...` /
   `... Rust nightly to YYYY-MM-DD`).

## Keeping our repositories alike

Before changing `deny.toml` or CI in our repositories, compare with siblings:

1. **Fetch 3–4 recently updated sibling repositories** of the same project type
   (Rust library, Rust binary, or pnpm app):
   - Public siblings on GitHub (excluding forks):
     `curl -sS 'https://api.github.com/orgs/M4SS-Code/repos?type=sources&per_page=100&sort=pushed' | jq -r '.[] | [.name, .pushed_at, .language] | @tsv'`
   - Private siblings on `code.m4ss.net` (requires `$FORGEJO_TOKEN`; ask for one
     if needed):
     `curl -sS -H "Authorization: token $FORGEJO_TOKEN" 'https://code.m4ss.net/api/v1/repos/search?mode=source&sort=updated&order=desc&limit=50'`
   - Read files from
     `https://raw.githubusercontent.com/M4SS-Code/<repo>/HEAD/<path>`,
     `https://code.m4ss.net/Mirror/<repo>/raw/branch/main/<path>`, or
     `https://code.m4ss.net/<owner>/<repo>/raw/branch/<branch>/<path>`.
2. **Identify the canonical template**: Follow the structure and conventions
   used by the most recently maintained siblings.
3. **Compare section by section**:
   - `deny.toml`: Match section order and settings; only `[graph] targets`,
     `[licenses] allow` and `[advisories] ignore` should differ based on the
     project.
   - Workflows: Match triggers, concurrency, permissions, job/step names,
     pinned action SHAs and toolchain pins; keep only project-specific features,
     services, or intentional differences (such as `ubuntu-24.04` release binary
     builds).
4. **Align unintended drift**, one concern per commit.
5. **Propagate improvements**: If the shared template itself has a flaw (missing
   hardening, outdated pin, better setting), fix it in this repository and list
   every sibling repository that needs the same fix in the report.
