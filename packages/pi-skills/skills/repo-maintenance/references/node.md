# Node.js dependencies (pnpm)

This assumes pnpm 12, which our projects pin in `packageManager`. Its
settings live in `pnpm-workspace.yaml`, even in a single-package project;
`.npmrc` only holds auth, registry and network settings. An unknown key in
`pnpm-workspace.yaml` fails the command when the project pins pnpm, so check
the spelling of anything you add there.

The commits come out in this order, each only when there's something to put
in it:

```text
build(deps): upgrade semver compatible Node dependencies
build(deps): upgrade <name> to v<version>    (a version younger than a day)
build(deps): upgrade <name> to v<major>      (one per upgrade or group)
build(deps): ...                             (standing holds that became obsolete)
```

## Strict policies on the command line

Every pnpm command here that resolves, installs or fixes (`update`, `add`,
`install`, `audit --fix`, `dlx`) runs with the release-age gate and the trust
policy set on the command line:

```sh
pnpm --config.minimumReleaseAge=1440 --config.trustPolicy=no-downgrade <command>
```

Set like this, they leave the project's configuration alone; don't write them
to `pnpm-workspace.yaml`. Setting `minimumReleaseAge` explicitly also makes
pnpm strict. When only a version younger than a day satisfies a specifier, it
fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION` instead of what it does by
default: installing the young version and quietly adding it, and every
platform package that comes with it, to `minimumReleaseAgeExclude`.

## The release-age gate

No version younger than a day goes in, unless it fixes a security issue that
affects us and its diff has been audited (step 5).

- Resolution picks the newest version that is at least a day old, for
  `update --latest` and `outdated` too.
- Every install, `--frozen-lockfile` included, checks the lockfile again. An
  entry younger than a day fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`
  unless `minimumReleaseAgeExclude` lists it. That's how a young version in
  the lockfile breaks CI, so an exception has to be written down there.
- On `ERR_PNPM_NO_MATURE_MATCHING_VERSION` outside step 5's case, take the
  newest mature version of a direct dependency instead. For a transitive one,
  hold back the dependency that brings it in (`update -r '!<parent>'`); an
  override is the user's call.

Exceptions name exact versions, never whole packages, with a comment saying
why:

```yaml
minimumReleaseAgeExclude:
  # GHSA-xxxx-xxxx-xxxx: diff from 1.2.2 audited
  - some-package@1.2.3
```

`pnpm audit --fix` writes patched versions there too, so check
`git diff -- pnpm-workspace.yaml` after it and keep only what step 5 allows.

To see when a version was published:
`npm view <name> time --json | jq -r '."<version>"'`.

## 1. Take a baseline

Note what the rest depends on:

- `packageManager` (and `devEngines.packageManager`, if present) in the root
  `package.json`.
- In `pnpm-workspace.yaml`: `packages` (a workspace, or a single project),
  `catalog` and `catalogs`, `minimumReleaseAgeExclude`, `trustPolicyExclude`,
  `allowBuilds`, `audit.ignore`, `overrides`, `patchedDependencies` and
  `update.githubActions`.
- The scripts CI runs after `pnpm install --frozen-lockfile`, usually
  `check`, `lint`, `test` and `build`. In SvelteKit projects `prepare` runs
  `svelte-kit sync`, and `check` runs `svelte-check`.
- The Node.js versions: `engines.node`, `.nvmrc` or `.node-version`, the CI
  matrix.
- Exact pins: specifiers without a range (`"1.2.3"`), or `save-exact` in the
  settings.
- What's published: which packages go to npm, and whether the others carry
  `"private": true` (`references/ci-audit.md`, "Publishing"). It decides
  whether a major upgrade breaks users (step 6); report a package that's
  missing its marker.

Then record the advisories before anything changes (`pnpm audit` exits with 1
when it finds something; that's fine here) and see what's outdated:

```sh
pnpm audit > <scratch>/audit-before.txt
pnpm outdated -r
```

## 2. Upgrade within the declared ranges

```sh
pnpm --config.minimumReleaseAge=1440 --config.trustPolicy=no-downgrade update -r
```

`-r` covers every package of a workspace and is harmless in a single project.
This raises each specifier's floor in `package.json` (`^3.9.4` becomes
`^3.9.10`), updates the catalog entries in `pnpm-workspace.yaml` behind
`catalog:` specifiers, and refreshes transitive dependencies in the lockfile.

With `update.githubActions: true`, the same command also re-pins the actions
in `.github/workflows/`. Those changes aren't dependency upgrades: take them
out of this commit, review and commit them as `references/ci-audit.md`
describes, and bring the Forgejo twins in line.

Exact pins don't move with `update -r`. Bump them within their major in this
commit like everything else (`update -r --latest <name>` with the strict
policies, then check it stayed in the same major), unless a comment or the
commit that pinned it says why it's pinned; that's a standing hold (step 9).

Errors to expect:

- `ERR_PNPM_NO_MATURE_MATCHING_VERSION`: see the gate above.
- `ERR_PNPM_IGNORED_BUILDS`: a package now has an install script nobody
  reviewed (step 7).
- `ERR_PNPM_TRUST_DOWNGRADE` (step 8).

Update the pnpm version in `packageManager` to the newest release of the same
major that is at least a day old (`npm view pnpm time --json`). Our pins carry
no hash; if one does (`+sha512.…`), regenerate it instead of editing it by
hand. A new pnpm major is a major upgrade like any other.

TypeScript doesn't follow semver: a minor release can add type errors. If it
breaks type checking and the fix is small, it goes in this commit. Otherwise
hold TypeScript back (`update -r '!typescript'`) and upgrade it in a commit
of its own.

## 3. Advisories

Compare the advisories with the baseline by ID, since the raw reports differ
in layout:

```sh
pnpm audit > <scratch>/audit-after.txt
diff <(grep -oE 'GHSA(-[0-9a-z]{4}){3}' <scratch>/audit-before.txt | sort -u) \
     <(grep -oE 'GHSA(-[0-9a-z]{4}){3}' <scratch>/audit-after.txt | sort -u)
```

Advisories that disappeared go in the body of the compatible-upgrade commit.
For each remaining one:

1. **Is there a fix?** `pnpm audit --json` gives `patched_versions`, which is
   `null` when there's none. Prefer `audit --fix=update` with the strict
   policies: it updates the lockfile, and its changes go in the
   compatible-upgrade commit. Plain `--fix` writes `overrides` to
   `pnpm-workspace.yaml`, which pin a transitive version until someone
   removes them; ask before adding one. If the fix is younger than a day,
   follow step 5.
2. **Does it apply?** Read the advisory (`https://github.com/advisories/<GHSA>`)
   for the affected functions and inputs, and find where the package sits:
   `pnpm why -r <name>`. In a SvelteKit app only the server and client bundles
   ship: dev servers, bundlers and linters run on developer machines and in
   CI. That matters for a denial of service through crafted input, not for a
   compromised package. `pnpm audit --prod` limits the report to
   `dependencies`.
3. **Act on it:**
   - It doesn't apply: report it, with the reasoning. Don't add it to
     `audit.ignore`; ignoring an npm advisory in the project's configuration
     is the user's call.
   - It applies without a fix, or the fix needs an override: stop and lay out
     the options.
   - A malicious or compromised package: stop everything and report at once:
     which versions are in the lockfile and since when, whether its install
     scripts could have run (only if `allowBuilds` allowed them), and that
     credentials on machines that installed it may need rotating.

## 4. Commit the compatible upgrade

First remove `minimumReleaseAgeExclude` entries for exact versions that are
now more than a day old or no longer in the lockfile (step 9): that's routine
housekeeping for this commit. Verify with
`pnpm --config.minimumReleaseAge=1440 --config.trustPolicy=no-downgrade install --frozen-lockfile`,
which checks the lockfile the way CI will, then with the checks from
SKILL.md's ground rules. Commit the `package.json` files, `pnpm-lock.yaml`
and any `pnpm-workspace.yaml` changes as
`build(deps): upgrade semver compatible Node dependencies`. Give it a body
only for what deserves attention: advisories fixed, release-age exceptions
removed, holds.

## 5. Taking a version younger than a day

Only to fix a security issue that affects us (step 3 decides). Then:

1. Audit the diff from the version we have (`references/changelogs.md`) as a
   supply-chain review: the fix should be all there is. Stop and report on
   any of these: new or changed install scripts (`preinstall`, `install`,
   `postinstall`, `prepare`), new dependencies, minified or obfuscated code
   where there was none, code reading environment variables, credentials or
   files outside the package, network access, `eval`, `new Function`,
   `child_process`, large encoded blobs, a new publisher or repository, or
   missing provenance where earlier releases had it
   (`npm view <name>@<version> dist.attestations`).
2. Add the exact version to `minimumReleaseAgeExclude`, commented with the
   advisory, along with the platform packages it brings in that are just as
   young (the error lists them all).
3. Upgrade the package, or the dependency that brings it in.
4. Commit as `build(deps): upgrade <name> to v<version>`, saying which
   advisory it fixes, that the version is younger than the gate, and that its
   diff was audited.

## 6. Major upgrades

`pnpm outdated -r` lists them: a `Latest` that the declared range doesn't
admit. npm's caret ranges follow Cargo's rule, so `^0.3` doesn't admit `0.4`.
One commit per upgrade or coupled group.

**Group by peer dependencies.** The new version's peers
(`npm view <name>@<version> peerDependencies`) say what has to move with it.
In SvelteKit projects the usual groups are:

- `svelte` with `@sveltejs/kit`, `@sveltejs/vite-plugin-svelte`,
  `svelte-check`, `eslint-plugin-svelte` and `prettier-plugin-svelte`;
- `vite` with `@sveltejs/vite-plugin-svelte` and `vitest`;
- `eslint` with `typescript-eslint` and the ESLint plugins;
- `typescript` with what checks types (`svelte-check`, `typescript-eslint`).

pnpm warns about unmet peers after resolving; don't commit with new ones.

`@types/node` follows the oldest Node.js major the project supports
(`engines.node`, the CI matrix), not the newest. Other `@types/*` packages
follow their library.

For each upgrade:

1. Review it with `references/changelogs.md`: the changelog, the migration
   guide, `npm diff` from the version locked now (after the compatible-upgrade
   commit), and our use of the package.
2. Upgrade with the strict policies: `update -r --latest <name>...`, or `add`
   with an explicit range in the right workspace package.
3. The Svelte family ships migration tools (`dlx sv migrate <migration>`,
   with the strict policies). Run one when the guide says so, then review what
   it changed.
4. Adapt our code and run the checks.
5. Commit `build(deps): upgrade <name> to v<major>`, with the body
   `references/changelogs.md` describes.

Skip and report upgrades the ecosystem isn't ready for, such as a peer range
that doesn't admit the new major yet. When the project publishes a package to
npm (it isn't `"private": true`) and the upgraded peer or dependency is part
of its public API (re-exported, or its types in ours), the upgrade breaks our
users: mark the subject with `!` and say what breaks in the body.

## 7. Install scripts

pnpm runs a dependency's install scripts only when `allowBuilds` in
`pnpm-workspace.yaml` allows it. A package with unreviewed scripts fails the
install with `ERR_PNPM_IGNORED_BUILDS`, since `strictDepBuilds` defaults to
true. An update that trips this brought in an install script nobody reviewed:
a new dependency with one, a dependency that gained one, or a new version of
a package approved only for specific versions (`nx@21.6.4: true`).

- A package that never had one gets one in a minor or patch release: treat it
  as a red flag and audit the diff before anything else.
- Otherwise read what the script does. If the package works without it
  (prebuilt binaries in optional dependencies, a no-op), set it to `false`
  with a comment saying why; that keeps it from running and needs no one's
  approval. If the script has to run, setting it to `true` is the user's
  call.

```yaml
allowBuilds:
  # esbuild works without its postinstall: the platform binary comes from the
  # @esbuild/* optional dependency; the script only validates/re-downloads it.
  esbuild: false
```

Never set `dangerouslyAllowAllBuilds`.

## 8. Trust downgrades

`ERR_PNPM_TRUST_DOWNGRADE` means a version was published with weaker trust
evidence than an earlier release: no provenance or trusted publishing where
an earlier version had it. A release published with a stolen token looks like
that, but so does a maintainer who publishes from CI one day and by hand the
next. The check covers what's already in the lockfile too, so the first run
can stop on an entry that has been there for months.

Look at who published what:

```sh
curl -sS https://registry.npmjs.org/<name> | jq -r '.time as $t | .versions | to_entries[]
  | [.key, $t[.key], (if .value.dist.attestations then "provenance" else "-" end),
     (if .value._npmUser.trustedPublisher then "trusted publisher" else "-" end),
     .value._npmUser.name] | @tsv'
```

(For a scoped package, write the name as `@scope%2Fname`.) A new publisher or
repository is a red flag; the same account alternating between trusted and
manual publishing is usually just an inconsistent release process. Either
way, stop and report what you found: accepting it is the user's call. Once
the user accepts a package, record it in `trustPolicyExclude` in
`pnpm-workspace.yaml`, with a comment saying why, so later runs don't stop on
it again.

## 9. Standing holds

Everything that keeps a dependency from moving was put there for a reason
that may be gone. Check each one:

- `minimumReleaseAgeExclude`: exact versions are obsolete once they're more
  than a day old, or no longer in the lockfile (`pnpm why -r <name>`).
  Entries naming a whole package or a pattern (`caniuse-lite`, `@scope/*`)
  are standing policy: leave them, but report any whose package is gone.
- `audit.ignore`: the report only counts ignored advisories ("1 ignored"),
  without naming them. To see which entries still match, save
  `pnpm-workspace.yaml` to `<scratch>`, empty the list, run
  `pnpm audit --json | jq -r '.advisories[].github_advisory_id' | sort -u`,
  and put the saved file back. Entries missing from that output are obsolete.
- `trustPolicyExclude`: an entry stays until the package publishes with
  consistent trust evidence again.
- `overrides` and `patchedDependencies`: obsolete when the versions they
  force, or the fixes they patch in, have been released and reached through
  the normal ranges.
- Exact pins kept on purpose: re-check the reason they give.

Remove what's obsolete in a `build(deps):` commit saying why it's no longer
needed, or in the compatible-upgrade commit when that's what made it
obsolete. An install with the strict policies and `--frozen-lockfile`
confirms the lockfile still passes afterwards. Report the holds that stay,
with their reasons.
