# Forgejo Actions

Forgejo Actions reads GitHub Actions syntax from `.forgejo/workflows/`. On any
Forgejo instance:

- there's no `permissions:` key: Forgejo doesn't support it, so leave it out;
- the context is `forgejo` (`github` is an alias), and the environment files
  are the `FORGEJO_*` variables, like `$FORGEJO_ENV`;
- a bare `owner/repo` in `uses:` resolves against the instance's
  `DEFAULT_ACTIONS_URL`, which its administrator chooses, so write full URLs.

Everything else in this file is about code.m4ss.net and applies only to our
repositories (SKILL.md, "Our repositories"). In anyone else's repository,
never point a workflow at code.m4ss.net, its mirrors or its images: that ties
their CI to infrastructure they don't control and that can change under
them, without them noticing. Use their instance's own mirrors and runner
labels, and ask where those are if the existing workflows don't show it.

## code.m4ss.net

Everything in `references/ci-audit.md` that isn't GitHub-only applies too.

When creating a repository on code.m4ss.net or making the first commits in
one that should be private, check with an unauthenticated `curl` that it
isn't public:
`curl -sS -o /dev/null -w '%{http_code}' https://code.m4ss.net/api/v1/repos/<owner>/<repo>`
must return `404` (a `200` means anyone can read it).

When a repository has the same CI in `.github/` and `.forgejo/`, the twins
run the same checks, and GitHub's side leads.
They may differ only where Forgejo forces it: the rules below, an action
whose version differs here (`upload-artifact`, `cache`), a release the mirror
doesn't have yet, and structure such as an MSRV matrix entry on GitHub
becoming a separate job on Forgejo. Any other difference is drift: fix it
when touching either side.

### Rules

1. **Every `uses:` is a full URL into the `Actions` organization**, pinned
   like on GitHub:

   ```yaml
   - name: Checkout
     uses: https://code.m4ss.net/Actions/checkout@<sha> # v7.0.1
     with:
       persist-credentials: false
   ```

   Every action lives under `https://code.m4ss.net/Actions/`. A `uses:` that
   points anywhere else is wrong and gets fixed: github.com,
   code.forgejo.org, data.forgejo.org, or another organization on
   code.m4ss.net such as `Mirror`.

2. **Official actions, mirrored.** `Actions` mirrors GitHub's official
   actions and the upstream repositories of third-party ones, and those are
   what workflows use. Forgejo's own forks of actions tend to fall behind:
   use one only where the official action can't work on Forgejo, and say why
   in a comment. At the time of writing that's only `upload-artifact`: the
   official one (v7) still refuses any server but github.com. The current
   list:
   `curl -sS 'https://code.m4ss.net/api/v1/orgs/Actions/repos?limit=50' | jq -r '.[].full_name'`.
   At the time of writing:

   | Repository          | Upstream                                   | Notes                                                                           |
   | ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
   | `checkout`          | `actions/checkout`                         |                                                                                 |
   | `setup-node`        | `actions/setup-node`                       |                                                                                 |
   | `setup-python`      | `actions/setup-python`                     | needs egress to github.com and pypi.org                                         |
   | `cache`             | `actions/cache`                            | a copy, not a live mirror: actions/cache#1795 breaks mirroring; updated by hand |
   | `rust-toolchain`    | `dtolnay/rust-toolchain`                   | used from its branch: `# master`                                                |
   | `install-action`    | `taiki-e/install-action`                   | also tags every tool: filter for version tags                                   |
   | `cargo-deny-action` | `EmbarkStudios/cargo-deny-action`          | a Docker action                                                                 |
   | `upload-artifact`   | `code.forgejo.org/forgejo/upload-artifact` | the exception: Forgejo's fork, versioned apart from GitHub's                    |
   | `cache-nix-action`  | `nix-community/cache-nix-action`           |                                                                                 |
   | `ci-images`         |                                            | the runner images, see below                                                    |

   Anything else (`download-artifact`, `pnpm/action-setup`,
   `Swatinem/rust-cache`, ...) has to be mirrored first: ask the user, don't
   reach outside. The image often makes it unnecessary: pnpm is preinstalled,
   so Forgejo workflows don't use `pnpm/action-setup`.

3. **Mirrors keep upstream's commits**, so a pin's SHA is the same as on
   GitHub. They sync every 8 to 24 hours, so check that a fresh release has
   arrived before pinning it:
   `git ls-remote https://code.m4ss.net/Actions/<repo> 'refs/tags/<tag>' 'refs/tags/<tag>^{}'`.
   For `cache`, only what's been pushed there exists.

4. **No code from forks.** The job containers on these runners are
   privileged, so every job carries this condition, with the comment on the
   first job:

   ```yaml
   # The job containers on these runners are privileged, so never run them
   # for code from a fork.
   if: forgejo.event_name != 'pull_request' || forgejo.event.pull_request.head.repo.full_name == forgejo.repository
   ```

5. **Runner labels**: `ubuntu-26.04` by default. Leave a job that builds
   release binaries on `ubuntu-24.04` unless asked (`references/ci-audit.md`,
   "Runners").

A job looks like this:

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

### The runner images

`https://code.m4ss.net/Actions/ci-images` builds the images behind both
labels, `code.m4ss.net/actions/ci-images:ubuntu-24.04` and `:ubuntu-26.04`.
They're modelled on GitHub's Ubuntu runner image, but carry only what our
projects need: one version each of Rust (stable, with clippy and rustfmt),
Go, Node.js and pnpm, plus Python, podman, skopeo, PHP and composer, jq,
SQLite and a PostgreSQL client. Paths follow the GitHub image, and jobs run
as the `runner` user with passwordless sudo. Its README documents what works
and what each tool needs; read it before relying on the image for something
new. Trust the Dockerfiles and this file over `ci-images`'s README when they
disagree (jobs run as `runner`, not `root`, and `uses:` must point to
`https://code.m4ss.net/Actions/`).

The toolchains in the image are a cache, not a constraint. Workflows still
ask for the versions and components they need (`rust-toolchain` with
`toolchain: ${{ env.RUST_VERSION }}` and `components: clippy` or `rustfmt`,
`setup-node`, the project's `packageManager` for pnpm); when that's the
version the image has, nothing gets downloaded, and otherwise the action
installs a fresh `--profile minimal` toolchain with only the requested
components. So the images and our repositories usually move to a new version
together, for speed and consistency, but a repository that hasn't moved yet
keeps working. For example, at the time of writing Node.js 26 has just become
the LTS release, while the images and our repositories are still on 24:
they'll move to 26 together.

Building container images with podman needs the privileged runner (see the
README).

### Bumping what the images pin

The Dockerfiles pin every toolchain by version and SHA-256, and keeping those
current is the maintenance. When Rust, rustup, Go, Node.js LTS or pnpm
releases:

1. Update `*_VERSION` and `*_SHA256` together. The comment above each
   checksum says where it comes from: rustup's `.sha256` file, go.dev/dl,
   Node.js's `SHASUMS256.txt`. pnpm publishes no checksum, so download the
   release tarball and run `sha256sum` on it, then cross-check it with the
   `digest` GitHub's API reports for that release asset
   (`curl -sS https://api.github.com/repos/pnpm/pnpm/releases/tags/v<version> | jq -r '.assets[] | select(.name == "pnpm-linux-x64.tar.gz") | .digest'`).
   Rust needs only `RUST_VERSION`, since rustup installs and verifies it.
2. Keep `ubuntu-24.04.Dockerfile` and `ubuntu-26.04.Dockerfile` identical
   apart from the base image.
3. Let a release age a day before taking it, like pnpm's gate, unless it's a
   security release. Patch and minor releases are routine, and so is each new
   Rust stable. A new major of Node.js or Go is a move for the images and our
   repositories together: propose it rather than doing it unasked.
4. The build job's own container, `quay.io/podman/stable`, is pinned by
   digest with the version in a comment. Tags get rebuilt, so re-pin when
   the digest changes:

   ```sh
   skopeo inspect --raw docker://quay.io/podman/stable:<tag> > <scratch>/manifest.json
   skopeo manifest-digest <scratch>/manifest.json
   ```

5. Commit in the repository's style:
   `ci: bump Rust to 1.NN.P, Node.js to 24.X.Y and pnpm to 12.X.Y`.

The build workflow publishes the images on every push to main, and weekly
for Ubuntu's package updates. Bumping a toolchain in the images goes well
with bumping the same pin in our repositories' workflows
(`chore(ci): upgrade Rust to v1.NN.P`, on GitHub and Forgejo alike), but
neither has to wait for the other.
