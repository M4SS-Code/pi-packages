# Reviewing an upgrade

Review every major upgrade and every `<1`-day release-age security exception
against the version locked immediately before this upgrade (i.e., after the
compatible-upgrade commit).

## 1. Find local usage

Identify how the repository uses the dependency before reading upstream changes:

- **Rust**: Search for paths and imports (`git grep -n -w '<crate_name>'` with
  hyphens converted to underscores, plus any `package = "..."` renames in
  `Cargo.toml`), enabled features
  (`cargo tree -q -e features -i <crate> --workspace --target all --all-features`),
  implemented traits and macros.
- **Node.js**: Search for imports
  (`git grep -n -E "['\"]<name>(/[^'\"]*)?['\"]"`), config files loading it
  (`vite.config.*`, `svelte.config.*`, `eslint.config.*`,
  `playwright.config.*`), and CLI invocations in `package.json` `scripts`.

## 2. Diff the published releases

Compare the artifacts published to the registry rather than git tags. Treat all
code in the release as untrusted until reviewed: read it, and never build,
install or execute anything from it.

### Rust

Cargo caches downloaded `.crate` tarballs and extracted sources under
`${CARGO_HOME:-$HOME/.cargo}/registry`:

```sh
R="${CARGO_HOME:-$HOME/.cargo}/registry"
ls $R/cache/index.crates.io-*/<crate>-<version>.crate
ls -d $R/src/index.crates.io-*/<crate>-<version>
```

Fetch any missing version via Cargo (`cargo fetch` for versions in
`Cargo.lock`, `cargo info <crate>@<version>` for others). Verify that each
cached `.crate`'s `sha256sum` matches the `checksum` recorded in `Cargo.lock`
(or `git show <commit>:Cargo.lock`). Then diff the extracted directories:

```sh
git diff --no-index --stat $R/src/index.crates.io-*/<crate>-<old> $R/src/index.crates.io-*/<crate>-<new>
git diff --no-index $R/src/index.crates.io-*/<crate>-<old> $R/src/index.crates.io-*/<crate>-<new>
```

Inspect all files in the diff, not only `src/`: check `build.rs`, proc-macro
code, and the normalized `Cargo.toml` (which carries the resolved dependency
version numbers, features and `rust-version`).

### Node.js

Use `npm diff` to compare the registry tarballs directly:

```sh
npm diff --diff=<name>@<old> --diff=<name>@<new> --diff-name-only
npm diff --diff=<name>@<old> --diff=<name>@<new> -- package.json <paths...>
```

When a package ships compiled output, inspect `*.d.ts` for API changes and the
compiled JS for behavior, falling back to the upstream source repository
(Section 3) when compiled code is unreadable.

### What to check in the diff

- Removed or modified public items we call, and changed defaults, error returns
  or panics.
- Feature flag changes (Rust) or `exports`, entry points, ESM/CJS changes,
  `engines` and `peerDependencies` (Node.js).
- Higher `rust-version` or Node.js requirements.
- New dependencies, or changes to `build.rs`, proc-macros or npm install
  scripts.
- New upstream APIs that can replace local workarounds, polyfills or
  `FIXME`/`TODO` comments.
- Deprecations affecting our calls.
- Supply-chain red flags (`references/node.md` Step 5, or Rust `build.rs` /
  proc-macros accessing network, environment variables or files outside the
  build): if found, stop immediately and report to the user.

For large diffs, start with `--stat` and the files touching our usage, then
skim the rest for supply-chain changes.

## 3. Read the changelog and migration guide

Read every release entry after the currently locked version up to and including
the target version. Check sources in this order and stop at the first source
that covers the target version:

```sh
# Filename filter matching standard changelog names, including versioned
# ones such as CHANGELOG-0.9.md or changes_v2.x.rst
FILTER='(^|/)((changelog|changes|history|news|releases|release[-_]?notes)([-_]v?[0-9][0-9.x]*)?(\.(md|rst|txt|adoc))?$|changelog/)'
```

1. **Published package files**:
   `(cd <extracted-dir> && find . -type f | grep -i -E "$FILTER")`
2. **Upstream git repository at the published commit**: Get the repository URL
   (`cargo info <crate>@<version>` or `npm view <name>@<version> repository.url`)
   and commit SHA (`git.sha1` in `.cargo_vcs_info.json`, or
   `npm view <name>@<version> gitHead` / provenance attestation):

   ```sh
   git clone -q --filter=blob:none --no-checkout <repository> <scratch>/<name>-repo
   git -C <scratch>/<name>-repo ls-tree -r --name-only <sha> | grep -i -E "$FILTER"
   git -C <scratch>/<name>-repo show <sha>:<path>
   ```

3. **Forge release notes**:
   - GitHub:
     `curl -sS 'https://api.github.com/repos/<owner>/<repo>/releases?per_page=100' | jq -r '.[] | [.tag_name, .published_at] | @tsv'`,
     then fetch `.body` from `.../releases/tags/<tag>`.
   - Forgejo / Gitea / Codeberg: `GET /api/v1/repos/<owner>/<repo>/releases`.
   - GitLab: `GET /api/v4/projects/<url-encoded-path>/releases`.
   - In monorepos, verify the tag (`v1.2.3`, `<name>-v1.2.3`, `<name>@1.2.3`)
     belongs to the target package. If release notes only list PR titles, fetch
     the PRs that touch our usage.
4. **Fallback (`git log`)**: If no changelog or release notes exist, inspect
   `git log --oneline <old-sha>..<new-sha>` in the blobless clone (scoped with
   `-- <subdir>` in a monorepo).

Also read any migration guide (`MIGRATION.md`, `UPGRADING.md`, or linked docs).
Trust the published release diff over the changelog whenever they disagree or
when the changelog omits changes.

## 4. Write the commit body

Summarize only what affects this repository, wrapped at 72 columns:

- breaking changes encountered and how our code was adapted;
- behavior or default changes in APIs we call (even if no code edit was needed);
- new requirements (MSRV, Node.js version, features, peer dependencies);
- new upstream APIs adopted now or noted for follow-up;
- relevant bug or security fixes.

Omit upstream changes to features or APIs this repository does not use. If
nothing in the upgrade affects our usage, state that in one sentence so
reviewers know the diff was audited:

```text
build(deps): upgrade quux to v0.9

`Parser::new` now takes the options by value, and `Parser::feed` returns
the number of bytes it consumed, so the reader loop no longer tracks the
offset itself. Unknown elements are now an error by default; we keep
the previous behavior with `Options::lenient`. 0.9 also adds
`Parser::reset`, which replaces the parser we rebuilt for every message.
```
