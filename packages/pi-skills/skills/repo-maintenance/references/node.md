# Node.js dependencies (pnpm)

This procedure targets pnpm 12 (pinned in `packageManager`). pnpm settings live
in `pnpm-workspace.yaml` (even in single-package repositories); `.npmrc` only
holds auth, registry and network settings. Unknown keys in
`pnpm-workspace.yaml` cause commands to fail when `packageManager` pins pnpm,
so check key names carefully.

Create commits in this order (omit any step that has no changes):

```text
build(deps): upgrade semver compatible Node dependencies
build(deps): upgrade <name> to v<version>    (a version younger than a day)
build(deps): upgrade <name> to v<major>      (one per upgrade or group)
build(deps): ...                             (standing holds that became obsolete)
```

## Mandatory pnpm flags and the 1-day release-age gate

Run every pnpm command that resolves, installs or fixes (`update`, `add`,
`install`, `audit --fix`, `dlx`) with these CLI flags:

```sh
pnpm --config.minimumReleaseAge=1440 --config.trustPolicy=no-downgrade <command>
```

Without these flags, pnpm silently installs releases younger than a day and
adds them to `minimumReleaseAgeExclude`. `trustPolicy=no-downgrade` makes pnpm fail instead
of installing a version with weaker publishing trust (for example, no
provenance) than the version it replaces.

Never write `minimumReleaseAge` or `trustPolicy` into `pnpm-workspace.yaml`.

Do not install any version published less than 24 hours ago (1440 minutes)
unless it fixes an applicable security advisory and passes a supply-chain diff
audit (Step 5):

- Resolution (`update`, `update --latest`, `outdated`) picks the newest version
  at least a day old.
- Every install (including `--frozen-lockfile` in CI) re-checks the lockfile
  and fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` if any locked version
  is younger than a day and not listed in `minimumReleaseAgeExclude`.
- If a command fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION` outside Step 5:
  - Direct dependency: select the newest version at least a day old.
  - Transitive dependency: hold back the parent package (`update -r '!<parent>'`).
    Adding an `overrides` entry requires user approval.
- Record approved Step 5 exceptions by exact version (never by bare package
  name), with a comment citing the advisory:

  ```yaml
  minimumReleaseAgeExclude:
    # GHSA-xxxx-xxxx-xxxx: diff from 1.2.2 audited
    - some-package@1.2.3
  ```

- `pnpm audit --fix` automatically appends patched versions to
  `minimumReleaseAgeExclude`: always inspect `git diff -- pnpm-workspace.yaml`
  after running it and keep only entries that satisfy Step 5.
- Check a version's publish timestamp with:
  `npm view <name> time --json | jq -r '."<version>"'`.

## 1. Take a baseline

Inspect the repository configuration:

- **pnpm version**: `packageManager` (and `devEngines.packageManager`, if set)
  in the root `package.json`.
- **Workspace settings (`pnpm-workspace.yaml`)**: `packages`, `catalog` /
  `catalogs`, `minimumReleaseAgeExclude`, `trustPolicyExclude`, `allowBuilds`,
  `audit.ignore`, `overrides`, `patchedDependencies` and
  `update.githubActions`.
- **CI scripts**: The commands CI runs after `pnpm install --frozen-lockfile`
  (typically `check`, `lint`, `test` and `build`; in SvelteKit repositories
  `prepare` runs `svelte-kit sync` and `check` runs `svelte-check`).
- **Node.js versions**: `engines.node`, `.nvmrc` / `.node-version`, and the CI
  matrix.
- **Exact pins**: Version specifiers without a range (`"1.2.3"`), or
  `save-exact` settings.
- **Published packages**: Check which packages are published to npm and whether
  unpublished ones set `"private": true` (`references/ci-audit.md`,
  "Publishing"). Report any unpublished package missing `"private": true`.

Record baseline advisories (`pnpm audit` exits with 1 when advisories exist)
and outdated packages:

```sh
pnpm audit > <scratch>/audit-before.txt
pnpm outdated -r
```

## 2. Upgrade within the declared ranges

Run across all workspace packages (`-r` is also safe in single-package repos):

```sh
pnpm --config.minimumReleaseAge=1440 --config.trustPolicy=no-downgrade update -r
```

This raises range floors in `package.json` (`^3.9.4` -> `^3.9.10`), updates
`catalog:` entries in `pnpm-workspace.yaml`, and refreshes transitive
dependencies in `pnpm-lock.yaml`.

Then handle these cases:

- **If `update.githubActions: true` modified `.github/workflows/`**: Do not
  include workflow changes in the dependency commit. Revert or unstage them,
  review and commit them separately per `references/ci-audit.md`, and sync
  `.forgejo/workflows/` twins.
- **If exact pins exist** (no range prefix): Check whether a comment or the
  commit that added the pin gives a reason (a standing hold for Step 9). If
  not, update it within its current major (`pnpm ... update -r --latest <name>`
  and verify the major did not change).
- **Update pnpm in `packageManager`**: Bump to the newest release of the same
  major that is at least a day old (`npm view pnpm time --json`). If the pin
  includes a `+sha512...` hash, regenerate it via pnpm rather than editing the
  hash manually. Treat a new pnpm major as a major upgrade (Step 6).
- **If a minor TypeScript update introduces type errors**: Include small fixes
  in this commit; if the fixes are non-trivial, hold TypeScript back
  (`update -r '!typescript'`) and move it to its own commit.
- **On policy errors**:
  - `ERR_PNPM_NO_MATURE_MATCHING_VERSION`: Follow the release-age gate rules
    above.
  - `ERR_PNPM_IGNORED_BUILDS`: Handle unreviewed install scripts in Step 7.
  - `ERR_PNPM_TRUST_DOWNGRADE`: Handle trust downgrades in Step 8.

## 3. Advisories

Re-run `pnpm audit` and diff advisory IDs against the baseline:

```sh
pnpm audit > <scratch>/audit-after.txt
diff <(grep -oE 'GHSA(-[0-9a-z]{4}){3}' <scratch>/audit-before.txt | sort -u) \
     <(grep -oE 'GHSA(-[0-9a-z]{4}){3}' <scratch>/audit-after.txt | sort -u)
```

Cite advisories resolved by `update -r` in Step 4's commit body. For each
remaining advisory:

1. **Check for a fix:** Check `patched_versions` in `pnpm audit --json` (`null`
   means no fix). Prefer `pnpm ... audit --fix=update`, which updates
   `pnpm-lock.yaml` without adding overrides, and include the change in Step 4.
   Plain `audit --fix` writes `overrides` to `pnpm-workspace.yaml`: ask the
   user before adding an override. If the fix is younger than a day, follow
   Step 5.
2. **Check whether it affects this repository:** Read
   `https://github.com/advisories/<GHSA>` for affected functions and inputs,
   and run `pnpm why -r <name>` (`pnpm audit --prod` checks only runtime
   `dependencies`). In SvelteKit apps, only server and client bundles ship to
   production; dev servers, bundlers and linters run only in CI and on
   developer machines (relevant for crafted-input DoS, but not for compromised
   packages).
3. **Act:**
   - **Does not apply:** Report it with the reasoning. Do not add it to
     `audit.ignore` unless the user asks.
   - **Applies and has no fix, or requires an override:** Stop and present the
     options to the user.
   - **Malicious or compromised package:** Stop immediately and report: which
     versions are locked and since when, whether its install scripts could have
     executed (only if permitted by `allowBuilds`), and that credentials on
     machines that installed it may need rotation.

## 4. Commit the compatible upgrade

1. Remove obsolete `minimumReleaseAgeExclude` entries (Step 9, "Standing
   holds").
2. Verify the lockfile passes strict CI checks:

   ```sh
   pnpm --config.minimumReleaseAge=1440 --config.trustPolicy=no-downgrade install --frozen-lockfile
   ```

3. Run the repository's CI checks (`check`, `lint`, `test`, `build`).
4. Commit `package.json`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` as
   `build(deps): upgrade semver compatible Node dependencies`. Add a body only
   for resolved advisories, removed release-age exceptions, or holds.

## 5. Taking a version younger than a day

Use this exception **only** for a release that fixes an applicable security
advisory (from Step 3):

1. Audit the diff from the currently locked version (`references/changelogs.md`)
   to confirm it contains only the fix. Stop and report immediately if the diff
   introduces any of the following supply-chain red flags:
   - new or modified install scripts (`preinstall`, `install`, `postinstall`,
     `prepare`);
   - new dependencies;
   - new minified, bundled or obfuscated code, or large encoded blobs;
   - access to environment variables, credentials, files outside the package,
     network, `eval`, `new Function` or `child_process`;
   - a changed publisher or repository URL, or missing provenance attestations
     when prior releases had them (`npm view <name>@<version> dist.attestations`).
2. Add the exact version (plus any equally young companion platform packages
   listed in the pnpm error) to `minimumReleaseAgeExclude` with a comment naming
   the advisory.
3. Upgrade the package (or its parent dependency) and run the checks.
4. Commit as `build(deps): upgrade <name> to v<version>`, stating the fixed
   advisory, that the release is under the 1-day gate, and that its diff was
   audited.

## 6. Major upgrades

Identify major upgrades from `pnpm outdated -r` (`Latest` outside the declared
range; `^0.3` does not allow `0.4`). Create one commit per upgrade or coupled
peer group.

**Group coupled packages by `peerDependencies`**
(`npm view <name>@<version> peerDependencies`):

- `svelte` + `@sveltejs/kit`, `@sveltejs/vite-plugin-svelte`, `svelte-check`,
  `eslint-plugin-svelte`, `prettier-plugin-svelte`
- `vite` + `@sveltejs/vite-plugin-svelte`, `vitest`
- `eslint` + `typescript-eslint`, ESLint plugins
- `typescript` + `svelte-check`, `typescript-eslint`

Do not commit upgrades that introduce new unmet peer dependency warnings. Keep
`@types/node` on the major matching the **oldest** supported Node.js release
(`engines.node` and CI matrix), not the newest. Keep other `@types/*` packages
aligned with their corresponding library major.

For each major upgrade (or group):

1. Audit the release diff and changelog (`references/changelogs.md`).
2. Upgrade with strict flags (`pnpm ... update -r --latest <name>...` or
   `pnpm ... add <name>@^<major>` in the target workspace package). If peer
   dependencies in the ecosystem do not yet support the new major, revert, skip
   the upgrade, and report it.
3. If upgrading Svelte/SvelteKit and the migration guide recommends
   `sv migrate`, run `pnpm ... dlx sv migrate <migration>` and review all
   resulting edits.
4. Adapt code to breaking changes and run CI checks.
5. Commit as `build(deps): upgrade <name> to v<major>` (or `build(deps)!:` if
   it breaks a published package's public API; see `SKILL.md`, "Commit
   subjects") with a body following `references/changelogs.md`.

## 7. Install scripts (`ERR_PNPM_IGNORED_BUILDS`)

`strictDepBuilds` is enabled by default, so pnpm blocks any package with
install scripts not listed in `allowBuilds` in `pnpm-workspace.yaml`. When an
update triggers `ERR_PNPM_IGNORED_BUILDS`:

- **If an existing package gained an install script in a minor or patch
  release:** Treat this as a supply-chain red flag and audit the release diff
  first (Step 5).
- **Otherwise, inspect the install script:**
  - If the package works without running the script (e.g., prebuilt binaries
    come from optional platform dependencies, or the script is a no-op), set
    `<package>: false` in `allowBuilds` with an explanatory comment (no user
    approval needed):

    ```yaml
    allowBuilds:
      # esbuild works without its postinstall: the platform binary comes from the
      # @esbuild/* optional dependency; the script only validates/re-downloads it.
      esbuild: false
    ```

  - If the script must run for the package to work, stop and ask the user
    before setting `<package>: true`.
- Never set `dangerouslyAllowAllBuilds`.

## 8. Trust downgrades (`ERR_PNPM_TRUST_DOWNGRADE`)

`ERR_PNPM_TRUST_DOWNGRADE` fires when a release has weaker trust evidence (no
provenance attestation or trusted publisher) than an earlier version of the
same package (including versions already in `pnpm-lock.yaml`).

Inspect the package's publishing history (URL-encode scoped packages as
`@scope%2Fname`):

```sh
curl -sS https://registry.npmjs.org/<name> | jq -r '.time as $t | .versions | to_entries[]
  | [.key, $t[.key], (if .value.dist.attestations then "provenance" else "-" end),
     (if .value._npmUser.trustedPublisher then "trusted publisher" else "-" end),
     .value._npmUser.name] | @tsv'
```

Stop and report the history to the user: distinguish a suspicious change (new
maintainer account or repository) from a single maintainer alternating between
CI and manual publishing. Add the package to `trustPolicyExclude` in
`pnpm-workspace.yaml` (with a comment) only if the user approves.

## 9. Standing holds

Check whether existing holds and exceptions in `pnpm-workspace.yaml` and
`package.json` are now obsolete:

- **`minimumReleaseAgeExclude`**: Remove exact-version entries (`pkg@1.2.3`)
  once the version is more than a day old or no longer in `pnpm-lock.yaml`
  (`pnpm why -r <name>`). Keep package-wide or glob policy entries
  (`caniuse-lite`, `@scope/*`), but report any whose package is no longer used.
- **`audit.ignore`**: To test which ignored GHSA IDs are still active, copy
  `pnpm-workspace.yaml` to `<scratch>`, clear `audit.ignore`, run
  `pnpm audit --json | jq -r '.advisories[].github_advisory_id' | sort -u`, and
  restore `pnpm-workspace.yaml`. Remove any ID no longer reported.
- **`trustPolicyExclude`**: Keep until the package resumes publishing with
  provenance/trusted publishing.
- **`overrides` and `patchedDependencies`**: Remove when normal dependency
  ranges resolve to a version containing the fix.
- **Intentional exact pins in `package.json`**: Verify whether the reason for
  pinning still applies.

Remove obsolete holds in a `build(deps): ...` commit explaining why each is no
longer needed (or fold into Step 4 when resolved by the compatible upgrade), and
verify with `pnpm ... install --frozen-lockfile`. Report all remaining holds
and their reasons.
