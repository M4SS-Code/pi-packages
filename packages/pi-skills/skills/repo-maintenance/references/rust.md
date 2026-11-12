# Rust dependencies

Follow these steps in order: the MSRV determines what the compatible upgrade
locks, and both determine which major upgrades apply. If `Cargo.lock` is not
tracked in git, skip the compatible-upgrade commit and run the remaining steps.

Create commits in this order (omit any step that has no changes):

```text
build(deps): allow the <license> license    (the baseline already needs it)
build!: bump MSRV to v1.NN
style(clippy): fix warnings enabled by the MSRV bump
refactor: ...                        (code that was waiting on the new MSRV)
build(deps): upgrade semver compatible Rust dependencies
build(deps): ignore RUSTSEC-YYYY-NNNN
build(deps): upgrade <crate> to v<major>     (one per upgrade or group)
build(deps): ...                     (standing holds that became obsolete)
chore(ci): upgrade Rust to v1.NN.P
```

## 1. Take a baseline

Inspect the repository configuration:

- **MSRV**: `rust-version` in `[workspace.package]` or each `[package]` (if
  set).
- **Resolver**: `resolver = "3"` (the default for `edition = "2024"`) respects
  `rust-version`; `"2"` and older ignore it. Virtual workspaces set `resolver`
  in `[workspace]`.
- **Advisory tool**: Use `cargo-deny` if `deny.toml` exists, otherwise
  `cargo-audit`. Install if missing (`cargo install --locked cargo-deny` or
  `cargo-audit`). Put advisory ignores only in `deny.toml`; never create or
  edit `.cargo/audit.toml`.
- **Target graph (`deny.toml` `[graph]`)**:
  - First verify `deny.toml` `[graph] targets` matches what CI builds
    (`references/ci-audit.md`, "What the jobs run"). If it mismatches, fix
    `deny.toml` in its own commit before recording the baseline.
  - Translate `[graph]` into `<graph>` flags for `cargo tree` so it inspects
    the exact graph `cargo-deny` checks:

    | `deny.toml` `[graph]` setting | `<graph>` flags for `cargo tree`           |
    | ----------------------------- | ------------------------------------------ |
    | `targets = [...]`             | `--target <triple>` for each listed triple |
    | No `targets` key              | `--target all`                             |
    | `exclude-dev = true`          | `-e normal,build`                          |

- **CI commands**: Note the clippy, test and MSRV job commands, their feature
  flags, whether CI pins the Rust toolchain and runs clippy on that pin
  (`references/ci-audit.md`, "Toolchains"), and `cargo-deny-action`'s
  `arguments` (`--all-features` in our repositories). Always pass `--workspace`
  to `cargo tree` and `cargo deny` (a root manifest with its own `[package]`
  otherwise checks only the root package; report if CI's `cargo-deny`
  arguments omit `--workspace` in such a repo).
- **Published crates**: Check which workspace crates are published to
  crates.io and whether unpublished ones set `publish = false`
  (`references/ci-audit.md`, "Publishing"). Report any unpublished crate
  missing `publish = false`.

Record the baseline advisories and duplicate versions (substitute the `<graph>`
flags from the table above when writing `dups.sh`):

```sh
cargo deny --workspace --all-features check advisories > <scratch>/advisories-before.txt 2>&1   # or: cargo audit
cat > <scratch>/dups.sh <<'EOF'
cargo tree -q -d --workspace <graph> --all-features --depth 0 --prefix none | sort -u \
  | awk 'NF { v[$1] = v[$1] " " $2; n[$1]++ } END { for (k in n) if (n[k] > 1) print k v[k] }' \
  | sort
EOF
sh <scratch>/dups.sh > <scratch>/dups-before.txt
```

(`dups.sh` uses `cargo tree` rather than `Cargo.lock` so unused optional
dependencies are ignored.)

## 2. Upgrade within the declared ranges (working tree only)

**State note:** Step 2 updates `Cargo.lock` in the working tree so Step 3 can
inspect what remains. Do **not** stage or commit `Cargo.lock` until Step 5.

**Release cooldown:** Never lock a version published less than a day ago,
unless it fixes an applicable security advisory (Step 6). Cargo enforces this
with `CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE="1 day"`. Prefix **every** `cargo`
command that can change `Cargo.lock` with it: `update`, and after manifest
edits `fetch`, `check`, `build`, `clippy`, `test` and `tree`. Never write
`global-min-publish-age` into `.cargo/config.toml`.

1. Check that the cooldown is active and whether the resolver respects the
   MSRV:

   ```sh
   cargo --version
   CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE="1 day" cargo update --dry-run 2>&1 | grep -E 'Locking|min-publish-age'
   ```

   - **Cooldown:** The `Locking` line must end with `as of 24 hours ago`. If
     instead Cargo prints
     `warning: ignoring registry.global-min-publish-age`, it is older than
     1.100 and resolves without the cooldown. Run every command listed above
     with `cargo +stable` instead (install it with
     `rustup toolchain install stable --profile minimal` if needed) and check
     again.
   - **MSRV:** If the `Locking` line says `highest Rust 1.NN compatible`, the
     MSRV is respected. If it says only `highest compatible` while
     `rust-version` is set, the resolver ignores the MSRV: also prefix every
     command listed above with
     `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback`, and note in the
     final report that setting `resolver = "3"` makes this automatic once the
     MSRV is `>= 1.84`.

   The cooldown prefix, the `+stable` toolchain and the MSRV prefix from this
   step are called the **Step 2 environment** below.

2. Update `Cargo.lock` without committing:

   ```sh
   CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE="1 day" cargo update
   ```

   If git dependencies (`git = "..."` or `[patch]`) moved to a newer commit,
   review `git log <old>..<new>` in their repositories like a release diff.

## 3. Read what's left

Run a verbose dry-run against the updated working-tree lockfile to see what
Step 2 could not update:

```sh
CARGO_REGISTRY_GLOBAL_MIN_PUBLISH_AGE="1 day" cargo update --dry-run --verbose 2>&1 | grep -E 'Unchanged|requires Rust'
```

Classify each output line:

- `Unchanged zstd-sys v2.1.2 (available: v2.1.3, published 40 minutes ago)`:
  Compatible release held back by the release cooldown. Leave it, and list it
  in the report. If it fixes an applicable advisory, handle it in Step 6.
- `Unchanged ctutils v0.4.2 (available: v0.4.8, requires Rust 1.87)`:
  Compatible release held back by the MSRV (reported for both direct and
  transitive dependencies). Handle in Step 4.
- `Unchanged criterion v0.7.0 (available: v0.8.2)`:
  Incompatible (major) upgrade for a direct dependency. A `requires Rust`
  suffix means it also needs an MSRV bump. Cargo only displays a major version
  that fits the current MSRV when one exists, which can hide an even newer
  major that requires a higher Rust version. For each direct dependency listed,
  check the newest release and its `rust-version`:
  `cargo search <crate> --limit 1` and `cargo info <crate>@<version>`.
- `Unchanged foo v1.2.3 (available: v1.2.9)` (no `requires Rust`):
  Compatible release blocked by an `=` or `<` pin or a `[patch]`. Locate the
  pin with `cargo tree -q -i foo@1.2.3 --workspace <graph> --all-features` and
  handle in Step 9.
- `Updating graviola v0.4.1 -> v0.4.4 (requires Rust 1.89)`:
  No version in range supports the MSRV, so Cargo fell back to an incompatible
  one. The current MSRV is already broken for features enabling this crate;
  report it and include it in Step 4.

(In Cargo semver, versions are compatible when their leftmost non-zero
components match: `1.2 -> 1.9` and `0.3.1 -> 0.3.9` are compatible;
`1.9 -> 2.0`, `0.3 -> 0.4` and `0.0.3 -> 0.0.4` are major upgrades.)

List where direct dependencies are declared:

```sh
cargo metadata --format-version 1 --no-deps \
  | jq -r '.packages[] as $p | $p.dependencies[] | select(.path == null)
      | [$p.name, .name, .req, (.kind // "normal")] | @tsv' | sort -u
```

If a member sets `foo.workspace = true`, edit its requirement in the root
`Cargo.toml` under `[workspace.dependencies]`.

Re-check advisories and diff the IDs against the baseline:

```sh
cargo deny --workspace --all-features check advisories > <scratch>/advisories-after.txt 2>&1
diff <(grep -oE 'RUSTSEC-[0-9]{4}-[0-9]{4}' <scratch>/advisories-before.txt | sort -u) \
     <(grep -oE 'RUSTSEC-[0-9]{4}-[0-9]{4}' <scratch>/advisories-after.txt | sort -u)
```

Compare yanked-crate warnings by crate name. Mention advisories and yanked
versions resolved by `cargo update` in Step 5's commit body. Include remaining
advisories whose fix requires a newer Rust in Step 4's question; handle all
others in Step 6.

## 4. Settle the MSRV

- **If nothing in Step 3 requires a newer Rust:** Proceed directly to Step 5.
- **If any compatible update, advisory fix or major upgrade requires a newer
  Rust:** Stop and ask the user whether to bump the MSRV. Include all decision
  details in a single message:
  - Current MSRV and latest stable Rust:
    `curl -sSf https://static.rust-lang.org/dist/channel-rust-stable.toml | awk '/^\[pkg\.rust\]/{getline; print}'`
  - Each held-back crate: locked version, available version, required Rust
    version, whether direct or via which dependency, and relevant fixes
    (advisories first, then relevant changelog fixes).
  - Major upgrades that require a newer Rust.
  - The lowest MSRV that unlocks the needed updates, and what a smaller bump
    would leave behind.

  Example prompt:

  ```text
  The MSRV (1.85) holds back:

  ctutils 0.4.2 → 0.4.8, needs 1.87, via digest (sha2, hmac, md-5):
    fixes RUSTSEC-2026-0385, which affects our signing
  graviola 0.4.4 already needs 1.89: the graviola backend doesn't build on 1.85
  criterion 0.7 → 0.8 (dev-dependency), needs 1.86

  1.89 covers all three; the latest stable is 1.99.1. Bump the MSRV to 1.89?
  ```

- **If the user declines (or in a non-interactive run):** Proceed to Step 5,
  list the held-back crates in the report, and (if non-interactive) place the
  MSRV question at the top of the report.

### If the user approves the MSRV bump

1. **Revert `Cargo.lock` first** so the MSRV commit builds against the original
   lockfile:

   ```sh
   git restore Cargo.lock
   ```

2. Find every reference to the old MSRV in tracked files:

   ```sh
   git grep -n -E 'rust-version|msrv|MSRV'
   git grep -n -F '1.OLD'    # inspect each match
   ```

3. Update the MSRV in:
   - `rust-version` in every `Cargo.toml` that sets it;
   - CI MSRV jobs in `.github/workflows/` and `.forgejo/workflows/` (toolchain
     flags like `rustup default 1.NN` or `toolchain: 1.NN.0`, job names like
     `msrv / 1.NN.0`, matrix entries, and cache keys);
   - `msrv` in `clippy.toml` (if present);
   - documentation and README badges, e.g.
     `[![Rustc Version 1.NN+](https://img.shields.io/badge/rustc-1.NN+-lightgray.svg)](https://blog.rust-lang.org/YYYY/MM/DD/Rust-1.NN.0/)`
     (get the release date from `rust-lang/rust`'s `RELEASES.md` and verify the
     URL resolves).
4. Commit as `build!: bump MSRV to v1.NN`. State what required the bump and end
   with what breaks:

   ```text
   build!: bump MSRV to v1.89

   The graviola backend requires Rust 1.89, so the declared MSRV only held
   for the other backends. The versions of ctutils, a dependency of digest,
   that fix RUSTSEC-2026-0385 also require Rust 1.87, so the MSRV-aware
   resolver kept a vulnerable version locked.

   This breaks builds with Rust 1.85 to 1.88, which have to upgrade.
   ```

5. **Fix newly enabled clippy lints:** Run CI's clippy commands with CI's
   pinned toolchain (`cargo +1.NN.P clippy ...`). Commit any fixes as
   `style(clippy): fix warnings enabled by the MSRV bump`, naming each lint and
   fix in the body.
6. **Clean up MSRV-gated code:** Check for `FIXME` comments waiting on the new
   MSRV, polyfills, `rustversion`/`autocfg` checks, or always-true `cfg`s.
   Commit small removals as `refactor: ...`; note larger refactors or newly
   available Rust editions (Edition 2024 requires 1.85) in the report without
   migrating unasked.
7. **Re-run `cargo update`** (with the Step 2 environment) to lock the newly
   unlocked versions, and re-run Step 3's dry-run to confirm nothing unexpected
   remains held back.

## 5. Commit the compatible upgrade

1. Run CI's check suite with `--locked`.
   - If CI has an MSRV job, run its commands with the MSRV toolchain
     (`rustup toolchain install 1.NN --profile minimal`) to catch crates that
     understate `rust-version`.
   - If a crate published to crates.io (Step 1, "Published crates") sets
     `rust-version` but CI has no MSRV job, run
     `cargo +1.NN check --locked --workspace --all-features` with the MSRV
     toolchain anyway, and list the missing MSRV job in the report. Do not add
     the job unless the user asked for a CI audit (`references/ci-audit.md`,
     "What the jobs run"). Binaries and unpublished crates do not need an MSRV
     job.
   - Run `cargo deny --workspace --all-features check` (checks licenses, bans
     and advisories). Stop and ask if a new dependency introduces an unallowed
     license.
2. Handle check failures:
   - **Fails only on the MSRV toolchain:** A crate understated its
     `rust-version`. Identify it from the compiler error, downgrade it with
     `cargo update -p <crate> --precise <last-working-version>`, check its
     upstream issue tracker, and report it.
   - **Fails on stable/pinned toolchain:** A compatible release regressed.
     Identify the crate from `git diff <base> -- Cargo.lock` (bisecting with
     `--precise` if needed), hold it back at the last working version, check
     its upstream issue tracker, and report it.
   - Note in the report that `--precise` holds only last until the next
     `cargo update` unless pinned in `Cargo.toml`.
   - Include minor code adjustments required by the compatible update (such as
     fixing a new deprecation warning under `-D warnings`) in this commit.
   - Remove any `deny.toml` advisory `ignore` entries that `cargo-deny` reports
     as no longer matching.
3. Commit `Cargo.lock` (and any accompanying fix or obsolete `deny.toml`
   ignore removal) as:
   `build(deps): upgrade semver compatible Rust dependencies`.
   Include a commit body only when there are fixed advisories (naming the
   affected crates and what uses them), replaced yanked versions, `--precise`
   holds, or removed `deny.toml` ignores:

   ```text
   build(deps): upgrade semver compatible Rust dependencies

   The locked version of ctutils, which the hmac, sha2 and md-5 crates use
   through digest, had non-constant-time mask generation and u128
   comparisons (RUSTSEC-2026-0385). The locked versions of h2, rustls and
   quinn-proto, dependencies of reqwest which only the tests and examples
   use, had 10 security advisories published since the last upgrade, and
   the locked version of chacha20 had been yanked.
   ```

## 6. Remaining advisories

Run `cargo deny --workspace --all-features check advisories` (or `cargo audit`
if there is no `deny.toml`).

For each vulnerability or `unsound` advisory:

1. **Check for a fix:**
   - Fix is in a new major of a direct dependency: handle it in Step 7 and cite
     the advisory in that commit's body.
   - Fix requires a transitive dependency to upgrade: run the upstream check
     from Step 8.
   - Fix is a compatible release held back by the release cooldown (Step 3):
     if the advisory applies (next point), audit the release diff
     (`references/changelogs.md`), then lock exactly that version with
     `CARGO_RESOLVER_INCOMPATIBLE_PUBLISH_AGE=allow cargo update -p <crate> --precise <version>`.
     Commit it on its own as
     `build(deps): upgrade <crate> to v<version>`, citing the advisory.
2. **Check whether it affects this repository:** Read the advisory
   (`https://rustsec.org/advisories/<ID>`) for affected functions, features and
   platforms. Check whether our code calls the function, enables the feature
   (`cargo tree -q -e features -i <crate> --workspace --target all --all-features`),
   uses the crate only in dev/build dependencies, or builds for the affected
   target.
3. **Act:**
   - **Does not apply, and `deny.toml` exists:** Ignore it in `deny.toml` in a
     dedicated commit `build(deps): ignore RUSTSEC-YYYY-NNNN` explaining why in
     both the comment/reason and commit body:

     ```toml
     [advisories]
     ignore = [
         { id = "RUSTSEC-YYYY-NNNN", reason = "only affects Foo::bar, which we don't call" },
     ]
     ```

   - **Does not apply, and no `deny.toml` exists:** Report it (do not create
     `deny.toml` or `.cargo/audit.toml`).
   - **Applies and has no simple fix (needs MSRV bump, override or upstream
     release):** Stop and present the options to the user.

For other advisory types:

- **`unmaintained`**: Report the crate and the alternatives listed in the
  advisory. Ignore in `deny.toml` only if the user asks.
- **`yanked`**: Run `cargo update -p <crate>` with the Step 2 environment.
  Report if no compatible unyanked version exists.
- **`malicious`**: Stop immediately without compiling anything that builds the
  crate (build scripts and proc-macros execute during `cargo check`/`build`)
  and report to the user.

## 7. Major upgrades

Upgrade direct dependencies that have incompatible updates (from Step 3), one
commit per upgrade or coupled group.

**Group coupled crates into one commit.** Crates that share public types must
upgrade together (e.g., `usvg`/`resvg`, `rustls`/`tokio-rustls`/`hyper-rustls`,
RustCrypto crates like `digest`/`sha2`/`hmac`/`md-5`,
`graviola`/`rustls-graviola`, `opentelemetry` crates). Detect coupled crates
when:

- the new release's manifest requires the new major of the other crate, or
- upgrading one alone fails with `expected foo::Type, found foo::Type` and
  `cargo tree -d` lists `foo` twice.

Check which other direct dependencies depend on the old major:
`cargo tree -q -i <crate>@<old> --workspace <graph> --all-features --depth 1`.

For each upgrade (or coupled group):

1. Update the version requirement in `Cargo.toml` (preserving the existing
   specifier style, e.g. `"0.23"` or `"2"`) and run `cargo fetch` with the
   Step 2 environment.
   `cargo fetch` resolves `Cargo.lock` and downloads the `.crate` without
   running build scripts or proc-macros. If resolution requires a higher MSRV,
   revert `Cargo.toml` and `Cargo.lock` and add it to Step 4's MSRV prompt.
2. Audit the release diff and changelog (`references/changelogs.md`).
3. Run `cargo check --workspace --all-targets --all-features` and adapt code to
   breaking changes. If our code relies on an API added after `.0`, set that
   minor/patch version as the minimum requirement in `Cargo.toml`. If the
   migration is large, revert, skip the upgrade, and report an estimate of the
   work required.
4. Run CI's checks and check for newly introduced duplicate versions (Step 8).
5. Commit as `build(deps): upgrade <crate> to v<major>` (or `build(deps)!:` if
   it breaks a published library's public API; see `SKILL.md`, "Commit
   subjects") with the commit body format from `references/changelogs.md`.
6. If the new release provides an API that cleanly replaces a small local
   workaround, commit that cleanup separately as `refactor: ...`; otherwise
   note it in the report.

## 8. Duplicate versions

After Step 5 and after each major upgrade in Step 7, diff duplicate versions
against the baseline:

```sh
sh <scratch>/dups.sh > <scratch>/dups-after.txt
diff <scratch>/dups-before.txt <scratch>/dups-after.txt
```

For each newly introduced duplicate, find the crates pulling in the older
version:

```sh
cargo tree -q -i <crate>@<older-version> --workspace <graph> --all-features --depth 1
```

Report every new duplicate and its offending parents. When only 1–3 crates hold
back the old version, check the upstream status of each offender:

1. Get the offender's repository URL (`cargo info <offender>@<version>`) and
   published git SHA (`git.sha1` in `.cargo_vcs_info.json`; see
   `references/changelogs.md`).
2. Check whether it is already upgraded on the upstream default branch:

   ```sh
   git clone -q --filter=blob:none --no-checkout <repository> <scratch>/<offender>-repo
   cd <scratch>/<offender>-repo
   git grep -l -E '^name = "<offender>"' origin/HEAD -- '*Cargo.toml'
   git show origin/HEAD:<manifest-path>
   git log --oneline <published-sha>..origin/HEAD
   ```

   (If the manifest uses `<crate>.workspace = true`, check the root
   `Cargo.toml` under `[workspace.dependencies]`.)

3. Check for open issues or PRs (including bot PRs). On GitHub:

   ```sh
   curl -sS 'https://api.github.com/search/issues?q=repo:<owner>/<repo>+<crate>&per_page=20' \
     | jq -r '.items[] | [(if .pull_request then "PR" else "issue" end), .state, .updated_at, .html_url, .title] | @tsv'
   ```

Report whether each offender is fixed on `HEAD` (commit and unreleased status),
has an open PR/issue (URL, state, last updated), or has neither. Never add
duplicate skips to `deny.toml` without asking.

## 9. Standing holds

Check whether existing holds and workarounds are now obsolete:

- `[patch]` entries and git dependencies waiting on an upstream release;
- `=` and `<` version pins (from Step 3): check the comment or `git log -S`
  commit that added the pin to see if the reason still holds;
- `deny.toml`: `[bans] skip` and `skip-tree` entries for resolved duplicates,
  and `[advisories] ignore` entries that no longer match;
- `--precise` lockfile holds mentioned in earlier commit messages (which
  `cargo update` will have cleared): verify the upstream regression was fixed.

Remove obsolete holds in a `build(deps): ...` commit explaining why the hold is
no longer needed (or fold into Step 5 when the compatible upgrade resolved it).
List all remaining holds and their reasons in the report.

## 10. CI's pinned toolchain

Verify that CI pins its Rust toolchain and runs `cargo clippy` on that pinned
version rather than floating `stable`, and bump the pinned toolchain if a newer
release is out. Follow `references/ci-audit.md` ("Toolchains").
