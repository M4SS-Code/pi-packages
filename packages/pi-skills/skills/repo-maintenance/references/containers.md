# Container images

Upgrade the images in a repository's Containerfiles (including `Dockerfile`s)
and Compose files. Use `podman` and `skopeo` for every command below; fall
back to `docker` only when `podman` is not installed.

Two kinds of Containerfile are handled elsewhere:

- `Actions/ci-images`: follow `references/forgejo.md` ("Maintaining
  `Actions/ci-images`").
- Containerfiles used only by CI: bump their Rust image in the same commit as
  `RUST_VERSION` (`references/ci-audit.md`, "Toolchains").

Images have no release-age gate: take the newest tag that matches the rules
below, however recent it is.

## 1. Find the files, their images and their versions

```sh
# Containerfiles: every FROM, and every ARG (an ARG above FROM can hold the tag)
git ls-files | grep -E '(^|/)(Dockerfile|Containerfile)([.-][^/]*)?$|\.(Dockerfile|Containerfile)$' \
  | while read -r f; do grep -n -H -E '^\s*(ARG|FROM)\b' "$f"; done
# Compose files: every image line
git ls-files | grep -E '(^|/)(docker-)?compose([.-][^/]*)?\.ya?ml$' \
  | while read -r f; do grep -n -H -E '^\s*image:' "$f"; done
# Variables inside image lines, such as ${NATS_TAG:-2.12-alpine}
git ls-files | grep -E '(^|/)(docker-)?compose([.-][^/]*)?\.ya?ml$' \
  | while read -r f; do grep -n -H -E '^\s*image:.*\$\{' "$f"; done
```

If the last search prints anything, look the variable up in the repository's
`.env` files (`git grep -n '^NATS_TAG=' -- '*.env*'`, with the variable's
name).

For each image, note:

- **The full reference:** registry, namespace, name, tag and any `@sha256:`
  digest.
- **Where its version lives:** in the `FROM` or `image:` line, in an `ARG`
  default (`ARG RUST_VERSION=1.96` with `FROM ...:${RUST_VERSION}-alpine3.23`),
  or in a Compose variable (`${NATS_TAG:-2.12-alpine}`, or a `.env` file).
  Change the version where it is defined.
- **Its role**, from the table in section 3.
- **In a multi-stage Containerfile:** which stages build a binary and which
  stage runs it.

A Compose service with `build:` instead of `image:` uses a Containerfile, which
the first search already covers.

## 2. Look up the current versions

Query these on every run; do not rely on versions written in this file.

```sh
# Rust stable
curl -fsSL https://static.rust-lang.org/dist/channel-rust-stable.toml | awk '/^\[pkg\.rust\]/{getline; print}'
# Alpine Linux stable (use it as 3.NN)
curl -fsSL https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/latest-releases.yaml | awk '/version:/{print $2; exit}'
# Debian stable codename
curl -fsSL https://deb.debian.org/debian/dists/stable/Release | awk '/^Codename:/{print $2}'
# Node.js: the newest LTS release (major and full version)
curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0].version'
```

To find the newest tag of an image, list its tags and keep only the stable
ones that have the shape you need. For example, the newest NATS 2.15 on Alpine:

```sh
podman search --list-tags --limit 10000 docker.io/library/nats \
  | awk 'NR > 1 {print $2}' \
  | grep -E '^2\.15\.[0-9]+-alpine3\.[0-9]+$' \
  | sort -V | tail -1
```

Write the `grep -E` pattern with digits only (`[0-9]+`), so release
candidates and betas (`19rc2`, `-beta`) never match. Before editing a file,
check that every tag you are about to write appears in this list.

To update a digest, take the multi-arch digest of the new tag:

```sh
skopeo inspect --format '{{.Digest}}' docker://docker.io/library/nats:2.15.3-alpine3.22
```

## 3. Upgrade each image

**Always write the full image name:** `docker.io/library/<image>` for Docker
Official Images, `docker.io/<namespace>/<image>` for other Docker Hub images,
and the registry's own name elsewhere (`quay.io/podman/stable`,
`ghcr.io/<org>/<image>`). Rewrite short names such as `FROM alpine:3.23` to
`FROM docker.io/library/alpine:3.24`. Prefer Docker Official Images and images
maintained by the upstream project (`docker.io/natsio/nats-box`,
`quay.io/skopeo/stable`); if a file uses a third-party image for something an
official image provides, report it and ask before replacing it.

**Never use a floating tag** (`latest`, `lts`, `stable`, `mainline`, `edge`,
`alpine`, `slim`, or a tag with no version, like `rust:slim-trixie`). Pin both
the software version and the distro version wherever the image publishes
distro variants. If a reference pins a digest, update the tag and the digest
together; do not add digests where there are none.

Each official image names its tags differently. Use exactly these shapes:

| Role               | Image                        | Tag shape                                 | Example                   |
| ------------------ | ---------------------------- | ----------------------------------------- | ------------------------- |
| Base OS            | `docker.io/library/alpine`   | `3.NN`                                    | `alpine:3.24`             |
| Base OS            | `docker.io/library/debian`   | `<codename>-slim`                         | `debian:trixie-slim`      |
| Toolchain          | `docker.io/library/rust`     | `1.NN-alpine3.NN`, `1.NN-slim-<codename>` | `rust:1.100-slim-trixie`  |
| Toolchain          | `docker.io/library/node`     | `NN-alpine3.NN`, `NN-<codename>-slim`     | `node:26-trixie-slim`     |
| Stateless service  | `docker.io/library/nginx`    | `X.Y.Z-alpine3.NN`, `X.Y.Z-<codename>`    | `nginx:1.30.6-alpine3.24` |
| Stateless tool     | `docker.io/natsio/nats-box`  | `X.Y.Z`                                   | `natsio/nats-box:0.20.2`  |
| Database or broker | `docker.io/library/postgres` | `X.Y-alpine3.NN`, `X.Y-<codename>`        | `postgres:17.12-trixie`   |
| Database or broker | `docker.io/library/nats`     | `X.Y.Z-alpine3.NN`                        | `nats:2.15.3-alpine3.22`  |

The examples omit the `docker.io/library/` prefix only to fit the table. Note
that `node` puts `slim` after the codename and `rust` puts it before, and that
`postgres` has no `slim` at all. For an image not in the table, list its tags
(section 2) and copy the shape of the tag it already uses.

### Toolchains (Rust, Node.js) and base OS images

- **Rust:** Use the same `1.NN` as `RUST_VERSION` in CI, without the patch
  version. If CI is behind the latest stable, bump both; if CI does not pin
  Rust, use the latest stable. If the project no longer compiles on the new
  Rust, keep the old version and follow `references/ci-audit.md`
  ("Toolchains") to find which release of the failing crate fixes it.
- **Node.js:** Use the Node.js major that CI uses (`node-version:`), or the one
  in `.nvmrc`, `.node-version` or `engines.node` in `package.json`. If none of
  them pins it, use the newest LTS major. A new major goes in its own commit,
  and the project's Node.js checks (`check`, `lint`, `test` and `build`, as CI
  runs them) must pass, as well as the image build.
- **Alpine Linux and Debian:** In a multi-stage Containerfile, every stage that
  builds a binary and the stage that runs it must use the same Alpine version
  or Debian codename: a binary built against a newer musl or glibc does not
  run on an older one. Use the newest version that every image in those stages
  publishes. When moving to a new Debian codename, check that every package in
  `apt-get install` still exists in it
  (`https://packages.debian.org/<codename>/<package>`).

### Stateless services and tools (nginx, caddy, nats-box, ...)

Upgrade to the newest release in the same major, pinned to the newest distro
version published for it (`nginx:1.30.6-alpine3.24`). Stop and ask before
changing the major version.

### Databases and brokers (postgres, nats, redis, valkey, mariadb, ...)

These images either deploy the service or stand in for the production one in
development and tests. Their version has to match production, and changing
their distro can corrupt existing data: PostgreSQL text indexes depend on the
collation of the distro's C library and ICU, and a different glibc, musl or
ICU version can make index scans miss rows or accept duplicate keys.

1. Find the version that runs in production: search the repository's
   deployment files (Ansible, NixOS, Terraform, Helm, production Compose and
   `.env` files) and its documentation. If the repository does not say, stop
   and ask which version runs in production.
2. Upgrade only to that version, or to the newest patch release in the same
   `X.Y` series.
3. Keep the distro exactly as it is (`17.12-bookworm` stays on `bookworm`,
   `17.12-alpine3.21` stays on `alpine3.21`), even when the rest of the
   repository moves to a newer Debian or Alpine. Changing it, or switching
   between Debian and Alpine, needs the user's confirmation and a planned
   `REINDEX`.

## 4. Verify

Build every Containerfile you changed, from the directory its `COPY` paths are
relative to (usually the repository root):

```sh
podman build -f path/to/Containerfile -t repo-maintenance-check .
podman image rm -f repo-maintenance-check
```

A failing `apk add` or `apt-get install` means a package was renamed or
removed in the new release: find its new name and fix it in the same commit.
If a build needs secrets or services that are not available locally, list it in
the report instead.

Check every Compose file you changed:

```sh
podman compose -f path/to/compose.yaml config -q
podman compose -f path/to/compose.yaml pull
```

Write build logs and other output to `<scratch>`.

## 5. Commit

Follow the scope the repository's history uses for these commits
(`git log --format=%s -- '*Dockerfile*' '*Containerfile*' '*compose*.y*ml'`),
usually `build(docker):`. One commit per kind of change, naming every version
that changed:

```text
build(docker): upgrade Rust to v1.100
build(docker): upgrade Alpine Linux to v3.24 / Rust to v1.100
build(docker): upgrade Debian to Trixie
build(docker): upgrade Node.js to v26
build(docker): upgrade nginx to v1.30.6
```

Put the switch to full image names in its own commit
(`build(docker): use fully qualified image names`) before the upgrades. In the
body, mention packages that had to be renamed and anything that changed for
the image at runtime.
