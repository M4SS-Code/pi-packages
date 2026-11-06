# Reviewing an upgrade

Every major upgrade, and every version taken under the release-age security
exception, gets this review. It answers three questions: what changed between
the version we have and the new one, which of those changes touch our code,
and what the commit body should say. The version we have is the one locked
right before this upgrade: after the compatible-upgrade commit, which may
already have moved it within its major.

## 1. Start from our usage

Knowing what we use keeps the review focused:

- **Rust**: paths and imports (`git grep -n -w '<crate_name>'`, with hyphens
  turned into underscores, and any `package = "..."` rename in the
  manifests), the features we enable
  (`cargo tree -q -e features -i <crate> --workspace --target all --all-features`),
  the traits we implement and the macros we use.
- **Node.js**: imports (`git grep -n -E "['\"]<name>(/[^'\"]*)?['\"]"`), the
  config files that load it (`vite.config.*`, `svelte.config.*`,
  `eslint.config.*`, `playwright.config.*`), and its CLI in `package.json`
  scripts.

## 2. Diff the published releases

What we build is what the registry serves, so compare the published
artifacts, not git tags.

**Rust**: the crates.io tarballs. Cargo usually has both already: the old
version from earlier builds, the new one since the upgrade resolved. It keeps
each `.crate` in its registry cache and the extracted sources next to it:

```sh
R="${CARGO_HOME:-$HOME/.cargo}/registry"
ls $R/cache/index.crates.io-*/<crate>-<version>.crate
ls -d $R/src/index.crates.io-*/<crate>-<version>
```

Fetch only what's missing, through Cargo, which keeps it for next time:
`cargo fetch` for versions in `Cargo.lock`, `cargo info <crate>@<version>` for
any other. Before trusting a cached copy, check that the `.crate` is the one
the lockfile pins: its SHA-256 (`sha256sum`) must equal the version's
`checksum` in `Cargo.lock`, or in `git show <commit>:Cargo.lock` for a version
an earlier commit locked. Then diff the extracted sources:

```sh
git diff --no-index --stat $R/src/index.crates.io-*/<crate>-<old> $R/src/index.crates.io-*/<crate>-<new>
git diff --no-index $R/src/index.crates.io-*/<crate>-<old> $R/src/index.crates.io-*/<crate>-<new>
```

Read all of it, not only `src/`: `build.rs`, proc-macro code and
`Cargo.toml.orig` are where new dependencies and build-time behavior show up.
The packaged `Cargo.toml` is normalized; `Cargo.toml.orig` is the one the
authors wrote, with its features, `rust-version` and dependencies.

**Node.js**: `npm diff` fetches both versions from the registry.

```sh
npm diff --diff=<name>@<old> --diff=<name>@<new> --diff-name-only
npm diff --diff=<name>@<old> --diff=<name>@<new> -- package.json <paths...>
```

Many npm packages ship only built output: read the type declarations
(`*.d.ts`) for API changes and the built code for behavior, and use the
source repository (section 3) where the built code is unreadable.

Everything in these releases is untrusted until reviewed: read it, never
build, install or run anything from it.

Look for:

- removed or changed public items we use, and changed defaults, errors and
  panics in what we call;
- feature changes (Rust), `exports` and entry points, ESM and CommonJS
  changes, `engines` and `peerDependencies` (Node.js);
- a higher `rust-version` or Node.js requirement;
- new dependencies, and changes to build scripts, proc-macros and install
  scripts;
- new APIs that would replace code of ours: workarounds, polyfills, `FIXME`
  and `TODO` comments pointing at upstream;
- deprecations of things we use.

For a huge diff, start from `--stat` and the files defining what we use, but
still skim the rest: an upgrade is also a supply-chain change.

## 3. Find the changelog

Read every entry after the version we have, up to and including the new one,
not just the newest. Look in this order, and stop at the first source that
covers the new version; a changelog file that stops before it doesn't count.
Changelog files go by many names, and this filter matches them
(`CHANGELOG.md`, `CHANGES.rst`, `HISTORY.md`, `NEWS`, `RELEASES.md`,
`RELEASE-NOTES.md`, a `changelog/` directory) while skipping the likes of
`release-plz.yml`:

```sh
grep -i -E '(^|/)((changelog|changes|history|news|releases|release[-_]?notes)(\.(md|rst|txt|adoc))?$|changelog/)'
```

1. **In the published release**: in the sources from section 2,
   `(cd <dir> && find . -type f | grep -i -E '<filter>')`.
2. **In the repository, unpublished**: find the repository
   (`cargo info <crate>@<version>` prints `repository:`;
   `npm view <name>@<version> repository.url`) and the commit the release was
   published from: `git.sha1` in the crate's `.cargo_vcs_info.json`, or
   `npm view <name>@<version> gitHead` (missing for some publishing setups;
   the provenance attestation also names the commit). A repository may keep
   one changelog for everything or one per crate or package, so list them
   all at that commit and pick the one that covers this package:

   ```sh
   git clone -q --filter=blob:none --no-checkout <repository> <scratch>/<name>-repo
   git -C <scratch>/<name>-repo ls-tree -r --name-only <sha> | grep -i -E '<filter>'
   git -C <scratch>/<name>-repo show <sha>:<path>
   ```

   The clone is blobless: `show` fetches only the files it reads.

3. **Release notes on the forge**: on GitHub,
   `curl -sS 'https://api.github.com/repos/<owner>/<repo>/releases?per_page=100' | jq -r '.[] | [.tag_name, .published_at] | @tsv'`
   lists them, and `.../releases/tags/<tag>` has a release's notes in
   `.body`. On Forgejo, Gitea and Codeberg,
   `GET /api/v1/repos/<owner>/<repo>/releases`; on GitLab,
   `GET /api/v4/projects/<url-encoded-path>/releases`. Tags vary (`v1.2.3`,
   `1.2.3`, `<name>-v1.2.3`, `<name>@1.2.3`); in a monorepo, make sure the
   notes are for this package. Notes generated from pull request titles are
   terse: open the pull requests behind the entries that touch what we use.

Majors often come with a migration guide as well (`MIGRATION.md`,
`UPGRADING.md`, a docs page or a blog post linked from the release notes).
Read it.

Without any of these, the commits between the two published ones are the
next best thing: `git log --oneline <old-sha>..<new-sha>` in that clone,
narrowed with `-- <directory>` when the repository holds many packages. Then
rely on the diff.

The diff has the last word. Changelogs omit things: use the changelog for the
intent, and the diff to confirm what affects us.

## 4. Write the commit body

Say what changed for us, not everything that changed upstream:

- breaking changes we hit, and how the code was adapted;
- behavior changes in things we use, even when our code didn't change;
- new requirements: MSRV, Node.js version, features, peers;
- new APIs we adopted, or that a follow-up should adopt;
- fixes that matter to us: an advisory, a bug we had worked around.

Leave out whatever we don't use, however prominent it is in the changelog.
If nothing affects us, say so in one sentence: knowing that the review
happened is useful. Write prose wrapped at 72 columns, like the rest of the
history. An illustration, with a made-up crate:

```text
build(deps): upgrade quux to v0.9

`Parser::new` now takes the options by value, and `Parser::feed` returns
the number of bytes it consumed, so the reader loop no longer tracks the
offset itself. Unknown elements are now an error by default; we keep
the previous behavior with `Options::lenient`. 0.9 also adds
`Parser::reset`, which replaces the parser we rebuilt for every message.
```

A review that turns up a supply-chain red flag (see step 5 of
`references/node.md`; for crates, build scripts or proc-macros reaching for
the network, the environment or files outside the build) ends the upgrade:
stop and report.
