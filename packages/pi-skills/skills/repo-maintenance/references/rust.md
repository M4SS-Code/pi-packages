# Rust dependencies

The steps depend on each other: the MSRV decides what the compatible upgrade
can lock, and both decide which major upgrades are worth doing. Follow them in
order. If `Cargo.lock` isn't tracked there is no compatible-upgrade commit;
the rest still applies.

The commits come out in this order, each only when there's something to put
in it:

```text
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

Note what the rest depends on:

- **The MSRV**: `rust-version` in `[workspace.package]` or in each
  `[package]`. There may be none.
- **The resolver**: `resolver = "3"`, the default for `edition = "2024"`
  packages, prefers versions that build on the MSRV; `"2"` and older ignore
  the MSRV. A virtual workspace sets it in `[workspace]`.
- **The advisory tool**: cargo-deny when `deny.toml` exists, cargo-audit
  otherwise. Install a missing one with `cargo install --locked cargo-deny`
  (or `cargo-audit`). Advisory ignores only ever go in `deny.toml`; never
  write cargo-audit's `.cargo/audit.toml`.
- **The graph cargo-deny checks**: `[graph]` in `deny.toml`. A library has no
  `targets` in `[graph]`, so cargo-deny checks every target. When CI builds
  binaries or container images for specific targets (the `--target` triples in
  its build jobs or in the `Dockerfile`s they build, or the builder image's
  own triple when `cargo build` runs without `--target`), `targets` in
  `[graph]` must match those exact triples; if an application's CI has no
  build job, keep whatever `targets` its `deny.toml` already lists. Fix a
  mismatch in `deny.toml` first in its own commit (`references/ci-audit.md`,
  "What the jobs run") so the baseline and CI check the right graph. Each
  entry of `targets` (a triple, or a table with `triple`) becomes a
  `--target <triple>` for `cargo tree`; without `targets`, use
  `--target all`. `exclude-dev = true` becomes `-e normal,build`. These are
  `<graph>` in the `cargo tree` commands below, so that what they show
  matches what cargo-deny checks in CI.
- **What CI runs**: the `run:` steps (the clippy and test commands, their
  feature combinations, the MSRV job, whether the Rust toolchain is pinned
  and whether the clippy jobs actually use that pinned version instead of the
  latest `stable`) and cargo-deny-action's `arguments` (`--all-features` in
  our repositories).
- **What's published**: which workspace crates go to crates.io, and whether
  the others carry `publish = false` (`references/ci-audit.md`,
  "Publishing"). It decides whether a major upgrade breaks users (step 7);
  report a crate that's missing its marker.

The commands below pass `--workspace` to `cargo tree` and `cargo deny`.
Without it, a root manifest that has its own `[package]` besides workspace
members makes them look at the root package only; only a virtual workspace
implies it. If CI's cargo-deny `arguments` lack it in such a repository,
report that CI doesn't check the other members.

Then record the state before anything changes, substituting the `<graph>`
flags into `dups.sh` as you write it:

```sh
cargo deny --workspace --all-features check advisories > <scratch>/advisories-before.txt 2>&1   # or: cargo audit
cat > <scratch>/dups.sh <<'EOF'
cargo tree -q -d --workspace <graph> --all-features --depth 0 --prefix none | sort -u \
  | awk 'NF { v[$1] = v[$1] " " $2; n[$1]++ } END { for (k in n) if (n[k] > 1) print k v[k] }' \
  | sort
EOF
sh <scratch>/dups.sh > <scratch>/dups-before.txt
```

`dups.sh` lists the crates built in more than one version, for the targets
and feature combinations that cargo-deny checks. It asks `cargo tree` on
purpose: `Cargo.lock` also lists optional dependencies of dependencies that
never get built, which don't count.

## 2. Upgrade within the declared ranges

First check whether resolution respects the MSRV:

```sh
cargo update --dry-run 2>&1 | grep Locking
```

- `Locking N packages to highest Rust 1.NN compatible versions`: it does.
- `Locking N packages to highest compatible versions` while a `rust-version`
  is declared: the resolver ignores it and can lock versions the MSRV job
  can't build. For the rest of the run, put
  `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback` in front of every
  cargo command that can write `Cargo.lock`: `update`, and `fetch`, `check`,
  `build`, `clippy`, `test` and `tree` after a manifest change. Note in the
  report that `resolver = "3"` would make that the default (only once the
  MSRV is at least 1.84, since older Cargo can't read it).

Then upgrade without committing yet (step 3 reads the result, and step 4 may
bump the MSRV before this upgrade is committed):

```sh
cargo update
```

Git dependencies (`git = "..."`, `[patch]` sections) move to the newest commit
of their branch. Review what came in (`git log <old>..<new>` in their
repository) as you would a release.

## 3. Read what's left

The dry run reads the lockfile in the working tree, so now it lists only what
step 2 couldn't take:

```sh
cargo update --dry-run --verbose 2>&1 | grep -E 'Unchanged|requires Rust'
```

Four kinds of lines matter:

- `Unchanged ctutils v0.4.2 (available: v0.4.8, requires Rust 1.87)`: a
  compatible release exists but needs a newer Rust. It's held back by the
  MSRV. Cargo reports these for any dependency, transitive ones included.
- `Unchanged criterion v0.7.0 (available: v0.8.2)`: the newest release is
  incompatible, so this is a major upgrade. Cargo reports these only for
  direct dependencies. A `requires Rust` suffix means the upgrade also needs
  an MSRV bump.
- `Unchanged foo v1.2.3 (available: v1.2.9)`: compatible, no Rust
  requirement, yet not taken. Something pins it: an `=` or `<` requirement, or
  a `[patch]`. Find what with
  `cargo tree -q -i foo@1.2.3 --workspace <graph> --all-features` and
  handle it in step 9.
- `Updating graviola v0.4.1 -> v0.4.4 (requires Rust 1.89)`: no release in
  range builds on the MSRV, so the resolver fell back to one that doesn't. The
  MSRV is already broken for whatever enables this crate; report it.

Cargo's compatibility rule tells compatible from incompatible: two versions
are compatible when their leftmost non-zero components are equal. `1.2 → 1.9`
and `0.3.1 → 0.3.9` are compatible; `1.9 → 2.0`, `0.3 → 0.4` and
`0.0.3 → 0.0.4` are not.

For a major upgrade, Cargo shows a release that fits the MSRV when one exists,
so a newer major that needs a newer Rust can hide behind it. For each direct
dependency with such a line, look up the newest release
(`cargo search <crate> --limit 1`; make sure the name matches) and its
`rust-version` (`cargo info <crate>@<version>`).

To find where a direct dependency is declared, list them with their
requirements:

```sh
cargo metadata --format-version 1 --no-deps \
  | jq -r '.packages[] as $p | $p.dependencies[] | select(.path == null)
      | [$p.name, .name, .req, (.kind // "normal")] | @tsv' | sort -u
```

A member that declares `foo.workspace = true` takes the requirement from
`[workspace.dependencies]` in the root manifest; that's where to edit it.

Check advisories again and compare the IDs with the baseline. The raw outputs
differ on every line, because locations and dependency trees move:

```sh
cargo deny --workspace --all-features check advisories > <scratch>/advisories-after.txt 2>&1
diff <(grep -oE 'RUSTSEC-[0-9]{4}-[0-9]{4}' <scratch>/advisories-before.txt | sort -u) \
     <(grep -oE 'RUSTSEC-[0-9]{4}-[0-9]{4}' <scratch>/advisories-after.txt | sort -u)
```

Yanked versions have no ID: compare those findings by crate. Advisories and
yanked versions that disappeared go in the body of the compatible-upgrade
commit. Include remaining advisories whose fix is held back by the MSRV in
step 4's question; handle the rest in step 6.

## 4. Settle the MSRV

Go to step 5 if nothing is held back by the MSRV: no `requires Rust` in step
3's output, and no newer major that needs a newer Rust.

Otherwise stop and ask whether to bump it, with everything needed to decide
in one message:

- the current MSRV, and the latest stable Rust:
  `curl -sSf https://static.rust-lang.org/dist/channel-rust-stable.toml | awk '/^\[pkg\.rust\]/{getline; print}'`;
- each held-back crate: locked and available versions, the Rust it requires,
  direct or through which dependency, and what the newer version brings
  (advisory fixes first, then the fixes from its changelog that matter to
  us);
- majors that also need a newer Rust;
- the lowest MSRV that unlocks everything worth having, and what a smaller
  bump would leave behind.

For example:

```text
The MSRV (1.85) holds back:

ctutils 0.4.2 → 0.4.8, needs 1.87, via digest (sha2, hmac, md-5):
  fixes RUSTSEC-2026-0385, which affects our signing
graviola 0.4.4 already needs 1.89: the graviola backend doesn't build on 1.85
criterion 0.7 → 0.8 (dev-dependency), needs 1.86

1.89 covers all three; the latest stable is 1.99.1. Bump the MSRV to 1.89?
```

If the answer is no, go to step 5 and list what stays held back in the
report. If nobody is there to answer, do the same and put the question at the
top of the report: a later yes gets a run of its own (the MSRV commit, the
lint fixes, then another compatible-upgrade commit for what the bump
unlocks).

### Bump the MSRV

Restore the lockfile first (`git restore Cargo.lock`): step 2's result was
for reading, and these commits must build with the lockfile they contain.

Find every place that states the old version, among tracked files:

```sh
git grep -n -E 'rust-version|msrv|MSRV'
git grep -n -F '1.OLD'    # judge each hit
```

Update:

- `rust-version` in every manifest that sets it;
- the CI job testing the MSRV, in `.github/workflows/` and
  `.forgejo/workflows/` alike: the toolchain (`rustup default 1.NN`,
  `toolchain: 1.NN.0`) and every repetition of the version (job names like
  `msrv / 1.NN.0`, matrix entries, cache keys like `rust-1.NN.0-...`);
- `msrv` in `clippy.toml`, if set: it overrides `rust-version` for clippy;
- the docs: README badges such as
  `[![Rustc Version 1.NN+](https://img.shields.io/badge/rustc-1.NN+-lightgray.svg)](https://blog.rust-lang.org/YYYY/MM/DD/Rust-1.NN.0/)`
  (the date is in rust-lang/rust's `RELEASES.md`, as
  `Version 1.NN.0 (YYYY-MM-DD)`; check that the link resolves),
  "Minimum supported Rust version" sections and crate-level docs.

An MSRV bump breaks the builds of whoever is on an older Rust, so it's a
breaking change: commit as `build!: bump MSRV to v1.NN`, saying what needed
it and, last, what breaks:

```text
build!: bump MSRV to v1.89

The graviola backend requires Rust 1.89, so the declared MSRV only held
for the other backends. The versions of ctutils, a dependency of digest,
that fix RUSTSEC-2026-0385 also require Rust 1.87, so the MSRV-aware
resolver kept a vulnerable version locked.

This breaks builds with Rust 1.85 to 1.88, which have to upgrade.
```

### Fix what the bump enables

Clippy reads the MSRV from `rust-version` and only suggests APIs that the MSRV
has, so a bump enables new lints (`collapsible_if` with let chains,
`missing_const_for_fn`, `manual_div_ceil`, ...). Run CI's clippy commands with
CI's pinned toolchain (`cargo +1.NN.P clippy ...`) and fix the new warnings in
their own commit, `style(clippy): fix warnings enabled by the MSRV bump`,
whose body names each lint and how it was fixed.

Then look for code that was waiting on this MSRV: comments like
`FIXME: ... with MSRV >= 1.NN`, polyfills, `rustversion` or `autocfg` version
checks, `cfg`s that are now always true. Small removals go in a `refactor:`
commit; list bigger ones in the report. If the new MSRV allows a newer
edition (2024 needs 1.85), say so, but don't migrate unasked.

Finally rerun `cargo update`, with the same environment as in step 2. It now
resolves against the new MSRV and takes what was held back. Rerun step 3's
dry run to check that nothing is still held back unexpectedly.

## 5. Commit the compatible upgrade

Run the checks from SKILL.md's ground rules, all with `--locked`. When CI has
an MSRV job, run its commands with the MSRV toolchain
(`rustup toolchain install 1.NN --profile minimal`): the MSRV-aware resolver
trusts each crate's declared `rust-version`, and a crate that understates or
omits it only shows up there. Run cargo-deny's full check as CI does
(`cargo deny --workspace --all-features check`): besides advisories it checks
licenses, and a new license missing from `[licenses] allow` fails CI and is
the user's call.

When a check fails:

- **Only on the MSRV toolchain**: a crate needs a newer Rust than it
  declares. Find it in the build error, hold it back with
  `cargo update -p <crate> --precise <last-working-version>`, and report
  it with its upstream issue tracker checked.
- **Elsewhere**: a compatible release regressed. Find it in
  `git diff <base> -- Cargo.lock`, bisecting with `--precise` if needed, check
  its issue tracker, hold it back at the last good version, and report it.

Say in the report that a `--precise` hold only lasts until the next
`cargo update`; making it durable is the user's call. Code changes the upgrade
forces, like a deprecation under `-D warnings`, go in this commit and its
body.

Commit `Cargo.lock` as
`build(deps): upgrade semver compatible Rust dependencies`. Give it a body
only when something deserves attention: advisories it fixes (with the
affected crates and what uses them), yanked versions it replaces, holds,
`deny.toml` ignores it made obsolete (remove those in this commit).

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

Run the check as CI does, with `--workspace`:
`cargo deny --workspace --all-features check advisories` with `deny.toml`,
`cargo audit` without it. Handle vulnerabilities and `unsound` advisories the
same way, since both usually have fixed releases:

1. **Is there a fix?** A compatible one should already be locked, unless the
   MSRV holds it back (step 4) or an `=` or `<` requirement or `[patch]` pins
   the crate (step 3). A fix in a new major of a direct dependency is done as
   a major upgrade (step 7), whose commit body names the advisory. A fix that
   a transitive dependency's maintainers have to adopt needs the upstream
   check from step 8.
2. **Does it apply?** Read the advisory (`https://rustsec.org/advisories/<ID>`,
   or its file in the rustsec/advisory-db repository) for the affected
   functions, features and platforms. Then check our side: do we call the
   affected API, do we enable the affected feature
   (`cargo tree -q -e features -i <crate> --workspace --target all --all-features`),
   is the crate only a dev- or build-dependency, does it build for our
   targets?
3. **Act on it:**

   - It doesn't apply and `deny.toml` exists: ignore it with the reason, in
     its own commit `build(deps): ignore RUSTSEC-YYYY-NNNN`, whose body gives
     the reasoning:

     ```toml
     [advisories]
     ignore = [
         { id = "RUSTSEC-YYYY-NNNN", reason = "only affects Foo::bar, which we don't call" },
     ]
     ```

   - It doesn't apply and there's no `deny.toml`: report it. Ignores live in
     `deny.toml` only: don't create one for this, and never write
     cargo-audit's `.cargo/audit.toml`.
   - It applies and has no fix, or the fix needs an MSRV bump, an override or
     an upstream release: stop and lay out the options.

Other kinds of findings:

- **Unmaintained** advisories are about the crate, not a version: only
  replacing it fixes them, and that's the user's call. Report them with the
  alternatives the advisory suggests; ignore them only if the user says so.
- **Yanked** versions: `cargo update -p <crate>` normally moves off them. If no
  compatible version is left, report it.
- **A malicious crate**: stop everything and report at once. Don't build
  anything that compiles it, since build scripts and proc-macros run at build
  time.

cargo-deny warns about `ignore` entries that no longer match anything. Remove
them, in the compatible-upgrade commit when that's what made them obsolete.

## 7. Major upgrades

Go through the direct dependencies that have an incompatible release (step 3),
one commit per upgrade.

**Group what has to move together.** Crates that use each other's types in
their public APIs only work at matching versions: `usvg` and `resvg`, `rustls`
with `tokio-rustls` and `hyper-rustls`, the RustCrypto crates (`digest`,
`sha2`, `hmac`, `md-5`), `graviola` and `rustls-graviola`, the
`opentelemetry` crates. The tell is that the new release of one requires the
new major of the other (read its `Cargo.toml`), or that upgrading one alone
fails with "expected `foo::Type`, found `foo::Type`" while `cargo tree -d`
shows `foo` twice. To see which of our dependencies use the old major too:
`cargo tree -q -i <crate>@<old> --workspace <graph> --all-features --depth 1`.
Upgrade such a group in one commit; everything else separately.

For each upgrade:

1. Edit the requirement where it's declared (a member's `Cargo.toml` or
   `[workspace.dependencies]`), in the style of the existing one (`"0.23"`,
   `"2"`), and run `cargo fetch` (with
   `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback` if step 2 needed it):
   Cargo resolves the new version into `Cargo.lock` with minimal lockfile
   changes and unpacks the `.crate` without running build scripts or
   proc-macros. If it needs a newer Rust than the MSRV, restore the manifest
   and lockfile and include it in step 4's question.
2. Review it with `references/changelogs.md`: the changelog for every release
   in between, the crates.io diff from the version locked in `HEAD`, and our
   use of the crate.
3. Build (`cargo check --workspace --all-targets --all-features`) and adapt
   our code to the breaking changes. Raise the minimum requirement in
   `Cargo.toml` if we use something added after `.0`.
4. Run the checks, then check duplicates (step 8).
5. Commit `build(deps): upgrade <crate> to v<major>`, with the body
   `references/changelogs.md` describes.

When the project publishes a library to crates.io and the upgraded
dependency is part of its public API (re-exports, public arguments, return
types and fields, trait implementations for its types), the upgrade breaks
our users: mark the subject with `!` (`build(deps)!: upgrade url to v3`) and
say what breaks in the body. A binary, or a crate with `publish = false`,
has no such users.

New upstream APIs that replace code of ours: when the replacement is small and
clearly better, make it a separate `refactor:` commit after the upgrade;
otherwise list it in the report. Skip upgrades that need a large migration,
and report them with an estimate of what's involved.

## 8. Duplicate versions

After the compatible-upgrade commit and after each major upgrade, compare with
the baseline:

```sh
sh <scratch>/dups.sh > <scratch>/dups-after.txt
diff <scratch>/dups-before.txt <scratch>/dups-after.txt
```

For each duplicate the work introduced, find the offenders, the crates still
on the older version:

```sh
cargo tree -q -i <crate>@<older-version> --workspace <graph> --all-features --depth 1
```

Report every new duplicate with its offenders. When a few crates (one to
three) hold on to the old version, rather than half the dependency tree,
check upstream for each one, because the user may want to send the fix
themselves:

1. Find its repository: `cargo info <offender>@<version>` (`repository:`),
   and the commit it was published from: `git.sha1` in its
   `.cargo_vcs_info.json` (see `references/changelogs.md`).
2. Is it fixed but unreleased? A blobless clone answers it on any forge:

   ```sh
   git clone -q --filter=blob:none --no-checkout <repository> <scratch>/<offender>-repo
   cd <scratch>/<offender>-repo
   git grep -l -E '^name = "<offender>"' origin/HEAD -- '*Cargo.toml'   # its manifest on the default branch
   git show origin/HEAD:<manifest-path>
   git log --oneline <published-sha>..origin/HEAD                       # what hasn't been released
   ```

   If the manifest says `<crate>.workspace = true`, the requirement is in the
   root manifest's `[workspace.dependencies]`.

3. Is there an open pull request or issue? Bot pull requests count. On
   GitHub:

   ```sh
   curl -sS 'https://api.github.com/search/issues?q=repo:<owner>/<repo>+<crate>&per_page=20' \
     | jq -r '.items[] | [(if .pull_request then "PR" else "issue" end), .state, .updated_at, .html_url, .title] | @tsv'
   ```

   Other forges have the equivalent in their web search or API.

For each offender, say which it is: fixed on the default branch but unreleased
(the commit, and the release it's missing from), an open pull request (link,
state, last activity), or nothing yet, which makes it a candidate for the user
to send upstream. Don't silence duplicates in `deny.toml` without asking.

## 9. Standing holds

Everything that keeps a dependency from moving was put there for a reason
that may be gone. Check each one:

- `[patch]` entries and git dependencies waiting for an upstream release:
  if the fix has been released, go back to the registry version;
- `=` and `<` requirements (found in step 3): the comment or the commit that
  added them says why; check whether it still holds;
- `deny.toml`: `[bans] skip` and `skip-tree` entries for duplicates that are
  gone, and advisory ignores whose crate or version is gone;
- `--precise` holds from earlier runs (look for them in past commit bodies)
  are gone after this run's `cargo update`: re-check the reason.

Remove what's obsolete in a `build(deps):` commit saying why it's no longer
needed, or in the compatible-upgrade commit when that's what made it
obsolete. Report the holds that stay, with their reasons.

## 10. CI's pinned toolchain

Check that CI pins its Rust version (`RUST_VERSION`, `toolchain: 1.NN.P`, or a
`rust:1.NN-...` image) and that every job running `cargo clippy` actually uses
that pinned version, with `components: clippy`, rather than the latest
`stable` (`references/ci-audit.md`, "Toolchains"). Fix any job that leaves the
toolchain unpinned or runs clippy on floating `stable`, and when a pinned
toolchain (stable, beta or nightly) has fallen behind, finish the run by
bumping it; our repositories pair this with their routine dependency upgrades.
