# Forgejo Actions

Forgejo Actions runs workflows from `.forgejo/workflows/` using GitHub Actions
syntax with three differences on every Forgejo instance:

- Omit `permissions:` (Forgejo does not support it).
- Use the `forgejo` context (`github` is an alias) and `FORGEJO_*` environment
  files (e.g., `$FORGEJO_ENV`).
- Always use full URLs in `uses:` (bare `owner/repo` resolves against the
  instance's `DEFAULT_ACTIONS_URL`).

**Scope:** The rest of this file applies only to our repositories (`SKILL.md`,
"Our repositories"). In an external repository, use its own instance's mirrors
and runner labels (ask if unknown).

## `code.m4ss.net`

All non-GitHub-specific rules in `references/ci-audit.md` apply here as well.

- **Private repository check**: When creating a repository on `code.m4ss.net`
  or making initial commits in one meant to be private, verify an
  unauthenticated request returns `404` (not `200`):
  `curl -sS -o /dev/null -w '%{http_code}' https://code.m4ss.net/api/v1/repos/<owner>/<repo>`.
- **`.github/` and `.forgejo/` twins**: When a repository has both, `.github/`
  is the primary reference and both must run the same checks. They may differ
  only where Forgejo requires it: the rules below, action versions that differ
  on Forgejo (`upload-artifact`, `cache`), releases not yet synced to the
  mirror, or job layout (e.g., an MSRV matrix entry on GitHub split into a
  standalone job on Forgejo). Fix any other difference when editing either side.

### Workflow rules

1. **Full `https://code.m4ss.net/Actions/` URLs in every `uses:`**, pinned to a
   commit SHA with a version comment:

   ```yaml
   - name: Checkout
     uses: https://code.m4ss.net/Actions/checkout@<sha> # v7.0.1
     with:
       persist-credentials: false
   ```

   Fix any `uses:` pointing to `github.com`, `code.forgejo.org`,
   `data.forgejo.org`, or another `code.m4ss.net` organization like `Mirror`.

2. **Use mirrored official actions** rather than Forgejo forks, except where the
   upstream action refuses non-GitHub servers (currently only `upload-artifact`
   v7; document the exception in a comment). Query current mirrors with:
   `curl -sS 'https://code.m4ss.net/api/v1/orgs/Actions/repos?limit=50' | jq -r '.[].full_name'`.

   Mirrors available at the time of writing:

   | Repository          | Upstream                                   | Notes                                                       |
   | ------------------- | ------------------------------------------ | ----------------------------------------------------------- |
   | `checkout`          | `actions/checkout`                         |                                                             |
   | `setup-node`        | `actions/setup-node`                       |                                                             |
   | `setup-python`      | `actions/setup-python`                     | Requires egress to `github.com` and `pypi.org`              |
   | `cache`             | `actions/cache`                            | Manual copy (not a live mirror due to `actions/cache#1795`) |
   | `rust-toolchain`    | `dtolnay/rust-toolchain`                   |                                                             |
   | `install-action`    | `taiki-e/install-action`                   |                                                             |
   | `cargo-deny-action` | `EmbarkStudios/cargo-deny-action`          | Docker action                                               |
   | `upload-artifact`   | `code.forgejo.org/forgejo/upload-artifact` | Forgejo fork, versioned separately                          |
   | `cache-nix-action`  | `nix-community/cache-nix-action`           |                                                             |
   | `ci-images`         | —                                          | Runner container images (see below)                         |

   If a workflow needs an unmirrored action (`download-artifact`,
   `Swatinem/rust-cache`, etc.), stop and ask the user to mirror it first. Note
   that `pnpm` is preinstalled in `ci-images`, so `pnpm/action-setup` is
   unnecessary on Forgejo.

3. **Verify the mirror has the commit before pinning**: Mirrors keep upstream
   commit SHAs and sync every 8–24 hours. Confirm the tag is present with:
   `git ls-remote https://code.m4ss.net/Actions/<repo> 'refs/tags/<tag>' 'refs/tags/<tag>^{}'`.

4. **Block fork pull requests on every job** (job containers run privileged;
   include the comment on the first job):

   ```yaml
   # The job containers on these runners are privileged, so never run them
   # for code from a fork.
   if: forgejo.event_name != 'pull_request' || forgejo.event.pull_request.head.repo.full_name == forgejo.repository
   ```

5. **Runner labels**: Use `ubuntu-26.04` by default. Keep release-binary build
   jobs on `ubuntu-24.04` unless asked (`references/ci-audit.md`, "Runners").

Example job:

```yaml
env:
  RUST_VERSION: 1.99.1

concurrency:
  group: ${{ forgejo.workflow }}-${{ forgejo.ref }}
  cancel-in-progress: true

jobs:
  clippy:
    # The job containers on these runners are privileged, so never run them
    # for code from a fork.
    if: forgejo.event_name != 'pull_request' || forgejo.event.pull_request.head.repo.full_name == forgejo.repository
    name: clippy / 1.99.1
    runs-on: ubuntu-26.04
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: https://code.m4ss.net/Actions/checkout@<sha> # v7.0.1
        with:
          persist-credentials: false

      - name: Rust toolchain
        uses: https://code.m4ss.net/Actions/rust-toolchain@<sha> # master
        with:
          toolchain: ${{ env.RUST_VERSION }}
          components: clippy

      - name: cargo clippy
        run: cargo clippy --locked --all-features -- -D warnings
```

### Runner images (`Actions/ci-images`)

`https://code.m4ss.net/Actions/ci-images` defines the images for `ubuntu-24.04`
and `ubuntu-26.04`. They preinstall one version each of Rust (stable with
`clippy` and `rustfmt`), Go, Node.js and pnpm, plus Python, podman, skopeo,
PHP/composer, jq, SQLite and the PostgreSQL client, running as user `runner`
with passwordless `sudo`. If `ci-images`'s README conflicts with its
`Dockerfile`s or this file, trust the `Dockerfile`s and this file.

Preinstalled toolchains act only as a local cache: workflows must still
explicitly request versions and components (`rust-toolchain` with
`toolchain: ${{ env.RUST_VERSION }}` and `components: clippy` / `rustfmt`,
`setup-node`, and `packageManager` in `package.json`). When a workflow requests
a version different from the image's, the action downloads and installs a
`--profile minimal` toolchain with the requested components.

### Maintaining `Actions/ci-images`

When updating pinned toolchains in `Actions/ci-images`:

1. Update `*_VERSION` and `*_SHA256` together in the `Dockerfile`s (following
   the source URL comment above each checksum; for `pnpm`, run `sha256sum` on
   the release tarball and cross-check against GitHub's release asset `digest`
   via `curl -sS https://api.github.com/repos/pnpm/pnpm/releases/tags/v<version> | jq -r '.assets[] | select(.name == "pnpm-linux-x64.tar.gz") | .digest'`).
   Rust only needs `RUST_VERSION`.
2. Keep `ubuntu-24.04.Dockerfile` and `ubuntu-26.04.Dockerfile` identical
   except for the `FROM` base image.
3. Enforce the 1-day release-age gate on non-security releases. Patch/minor
   updates and new Rust stable releases are routine; ask before bumping Node.js
   or Go to a new major.
4. Check whether `quay.io/podman/stable:<tag>` in the build workflow has a
   newer digest and update the pinned digest if so:

   ```sh
   skopeo inspect --raw docker://quay.io/podman/stable:<tag> > <scratch>/manifest.json
   skopeo manifest-digest <scratch>/manifest.json
   ```

5. Commit per `SKILL.md`, "Commit subjects". `ci-images` and workflow pins can
   be bumped together or separately.
