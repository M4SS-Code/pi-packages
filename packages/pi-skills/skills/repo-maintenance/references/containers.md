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
# Containerfiles: every FROM, every ARG (an ARG above FROM can hold the tag),
# and images used by COPY --from= or RUN --mount=...,from=
git ls-files | grep -E '(^|/)(Dockerfile|Containerfile)([.-][^/]*)?$|\.(Dockerfile|Containerfile)$' \
  | while read -r f; do grep -n -H -E '^\s*(ARG|FROM)\b|--from=[^ ]*[/:]|from=[^ ,]*[/:]' "$f"; done
# Compose files: every image line
git ls-files | grep -E '(^|/)(docker-)?compose([.-][^/]*)?\.ya?ml$' \
  | while read -r f; do grep -n -H -E '^\s*image:' "$f"; done
# Variables inside image lines, such as ${NATS_TAG:-2.12-alpine}
git ls-files | grep -E '(^|/)(docker-)?compose([.-][^/]*)?\.ya?ml$' \
  | while read -r f; do grep -n -H -E '^\s*image:.*\$\{' "$f"; done
# CI workflows: job containers and service containers
git grep -n -E '^\s*(image|container):' -- .github .forgejo
```

If the third search (variables inside image lines) prints anything, look the
variable up in the repository's `.env` files
(`git grep -n '^NATS_TAG=' -- '*.env*'`, with the variable's name).

Workflow images follow the same tag rules as the rest of this file, and are
also pinned by digest (`references/ci-audit.md`, "Pinning"). Containerfiles
and Compose files get a digest only if they already have one.

For each image, note:

- **The full reference:** registry, namespace, name, tag and any `@sha256:`
  digest.
- **Where its version lives:** in the `FROM` or `image:` line, in an `ARG`
  default (`ARG RUST_VERSION=1.96` with `FROM ...:${RUST_VERSION}-alpine3.23`),
  or in a Compose variable (`${NATS_TAG:-2.12-alpine}`, or a `.env` file).
  If an `ARG` has no default, its value comes from a `--build-arg` in a CI
  workflow or from `args:` under a Compose service's `build:`. Change the
  version where it is defined.
- **Its registry:** for a private registry (such as `code.m4ss.net`),
  `podman search` and `skopeo inspect` need a login. If you have none, list
  the image in the report instead of guessing its tags.
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
`FROM docker.io/library/alpine:3.23`, keeping the version (the upgrade is a
separate commit), unless the repository's README,
contributing guide or a comment in the file asks for short names; then leave
them and say so in the report. Prefer Docker Official Images and images
maintained by the upstream project (`docker.io/natsio/nats-box`,
`quay.io/skopeo/stable`); if a file uses a third-party image for something an
official image provides, report it and ask before replacing it.

**Never use a floating tag.** A tag is floating when it lacks any part of its
shape in the table below: `latest`, `lts`, `stable`, `mainline`, `edge`,
`alpine`, `slim`, `rust:slim-trixie` (no version), `postgres:18-alpine3.24`
(no minor) and `nginx:1.30-alpine3.24` (no patch) are all floating;
`rust:1.100-slim-trixie` and `alpine:3.24` are complete. Pin both the software
version and the distro version wherever the image publishes distro variants.
If a reference pins a digest, update the tag and the digest together; do not
add digests where there are none (workflow images are the exception, see
section 1).

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
  in `.nvmrc`, `.node-version`, or `engines.node` or `devEngines` in
  `package.json`. If none of
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

For nginx, an even second number (`1.30`) is the stable branch and an odd one
(`1.31`) is mainline. Stay on the branch the file uses: upgrade `1.30.x` only
to a newer `1.30.x` (`grep -E '^1\.30\.[0-9]+-alpine3\.[0-9]+$'`), or to the
next even branch once it exists. Never move from an even branch to an odd one.

### Databases and brokers (postgres, nats, redis, valkey, mariadb, ...)

These images either deploy the service or stand in for the production one in
development and tests. Their version has to match production, and changing
their distro can corrupt existing data: PostgreSQL text indexes depend on the
collation of the distro's C library and ICU, and a different glibc, musl or
ICU version can make index scans miss rows or accept duplicate keys.

If the image uses a floating tag (`postgres:18-alpine`), first pin it to the
exact tag it points to today: the tag with the same digest. Compare the
floating tag's digest with the tags of its series, newest first, and stop at
the first match:

```sh
want=$(skopeo inspect --format '{{.Digest}}' docker://docker.io/library/postgres:18-alpine)
podman search --list-tags --limit 10000 docker.io/library/postgres \
  | awk 'NR > 1 {print $2}' \
  | grep -E '^18\.[0-9]+-alpine3\.[0-9]+$' \
  | sort -rV \
  | while read -r t; do
      if [ "$(skopeo inspect --format '{{.Digest}}' "docker://docker.io/library/postgres:$t")" = "$want" ]; then
        echo "$t"
        break
      fi
    done
```

Adapt the `grep -E` pattern to the floating tag. For a Debian-based tag such
as `postgres:18` use `'^18\.[0-9]+-[a-z]+$'` (codename variants like
`18.7-trixie`); if the major is unknown, as with `postgres:latest`, use
`'^[0-9]+\.[0-9]+-[a-z]+$'`. Use these two patterns only for Debian-based
tags: for an Alpine tag keep the `-alpine3\.[0-9]+` pattern above, or the loop
prints `18.7-alpine`, which is still floating. Within a Debian tag, other
codenames the pattern lets through do no harm, because only a tag with the
same digest is printed.

If it prints a tag, pinning to it changes nothing that runs, so it needs no
production check. Commit it on its own with `pin` in the subject, not
`upgrade`. If it prints nothing, no tag matches: stop and ask, and do not pin
to the newest tag, because that would change the version that runs. Upgrade a
pinned image, if at all, with the steps below.

1. Find the version that runs in production: search the repository's
   deployment files (Ansible, NixOS, Terraform, Helm, Kustomize, production
   Compose and `.env` files), the database and broker containers its CI starts
   (`services:` in `.github/workflows/` and `.forgejo/workflows/`), and its
   documentation. If the repository does not say, stop
   and ask which version runs in production.
2. Upgrade only to that version, or to the newest patch release of the same
   series. The series depends on the tag shape: for `X.Y.Z` images such as
   `nats`, the series is `X.Y` and patches change `Z` (`2.15.1` to `2.15.3`);
   for `X.Y` images such as `postgres`, the series is `X` and patches change
   `Y` (`17.11` to `17.12`).
3. Keep the distro exactly as it is (`17.12-bookworm` stays on `bookworm`,
   `17.12-alpine3.21` stays on `alpine3.21`), even when the rest of the
   repository moves to a newer Debian or Alpine. Changing it, or switching
   between Debian and Alpine, needs the user's confirmation and a planned
   `REINDEX`.

## 4. Verify

Before each commit, build every Containerfile you changed. These commands run
from the repository root, which is where `COPY` paths usually start; if a
Containerfile's `COPY` paths start elsewhere, build that one from there.

```sh
git diff --name-only HEAD \
  | grep -E '(^|/)(Dockerfile|Containerfile)([.-][^/]*)?$|\.(Dockerfile|Containerfile)$' \
  | while read -r f; do
      log="<scratch>/build-$(echo "$f" | tr / _).log"
      if podman build -f "$f" -t repo-maintenance-check . > "$log" 2>&1 < /dev/null; then
        echo "$f: built"
      else
        echo "$f: FAILED, see $log"
      fi
      podman image rm -f repo-maintenance-check > /dev/null 2>&1
    done
```

A failing `apk add` or `apt-get install` means a package was renamed or
removed in the new release: find its new name and fix it in the same commit.
If a build needs secrets or services that are not available locally, list it in
the report instead.

Check that every Compose file you changed is still valid and that its images
can be pulled (`pull` skips the services that have `build:`):

```sh
git diff --name-only HEAD \
  | grep -E '(^|/)(docker-)?compose([.-][^/]*)?\.ya?ml$' \
  | while read -r f; do
      podman compose -f "$f" config -q < /dev/null \
        && podman compose -f "$f" pull < /dev/null \
        && echo "$f: valid, images pulled"
    done
```

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
build(docker): pin Postgres to v18.7
```

Put the switch to full image names in its own commit
(`build(docker): use fully qualified image names`) before the upgrades. In the
body, mention packages that had to be renamed and anything that changed for
the image at runtime.
