# Dockerfile and Compose images

Upgrade the images in a repository's Dockerfiles and Compose files: Rust,
Node.js, Alpine Linux, Debian and other images such as nginx or NATS.
`Actions/ci-images` installs its toolchains differently; follow
`references/forgejo.md` ("Maintaining `Actions/ci-images`") for it.

## 1. Find the files and their images

```sh
# Dockerfiles, and the image of each stage
git ls-files | grep -E '(^|/)(Dockerfile|Containerfile)([.-][^/]*)?$|\.(Dockerfile|Containerfile)$'
grep -n -E '^\s*FROM' <each Dockerfile>
# Compose files, and the image of each service
git ls-files | grep -E '(^|/)(docker-)?compose([.-][^/]*)?\.ya?ml$'
grep -n -E '^\s*image:' <each Compose file>
```

For each `FROM` or `image:`, note the image, the tag and any `@sha256:`
digest. In a Dockerfile, note which stages build a binary and which stage runs
it. A Compose service with `build:` instead of `image:` uses a Dockerfile,
which the search above already covers.

## 2. Look up the current versions

Query these on every run; do not rely on versions written in this file.

```sh
# Rust stable
curl -sSf https://static.rust-lang.org/dist/channel-rust-stable.toml | awk '/^\[pkg\.rust\]/{getline; print}'
# Alpine Linux stable
curl -sS https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/x86_64/latest-releases.yaml | awk '/version:/{print $2; exit}'
# Debian stable codename
curl -sS https://deb.debian.org/debian/dists/stable/Release | awk '/^Codename:/{print $2}'
# Node.js Active LTS major
curl -sS https://raw.githubusercontent.com/nodejs/Release/main/schedule.json \
  | jq -r --arg now "$(date -u +%F)" 'to_entries[] | select((.value.lts // "9") <= $now and .value.maintenance > $now) | .key'
# Whether a tag exists on Docker Hub (prints a date if it does). Official
# images like rust or nats use the namespace "library"; others name their own,
# such as natsio/nats-box.
curl -sS https://hub.docker.com/v2/repositories/<namespace>/<image>/tags/<tag> | jq -r '.last_updated // .message'
# The newest tags of an image, to find its current release
curl -sS 'https://hub.docker.com/v2/repositories/<namespace>/<image>/tags?page_size=20&ordering=last_updated' | jq -r '.results[].name'
```

Use the Alpine version as `3.NN` (major.minor) and the Debian release by its
codename (`trixie`). Check that every tag you are about to write exists before
editing the file.

## 3. Upgrade each image

- **Explicit versions:** Every tag names its versions. Replace floating tags
  (`rust:slim-trixie`, `rust:alpine`, `node:lts-alpine`, `alpine:latest`,
  `natsio/nats-box:latest`) with versioned ones, such as
  `rust:1.100-slim-trixie` or `natsio/nats-box:0.20.2`. Keep the repository's
  style: if an image pins a digest (`image:tag@sha256:...`), update the tag and
  the digest together; do not add digests where there are none.
- **Rust:** Use the same `1.NN` as `RUST_VERSION` in CI
  (`references/ci-audit.md`, "Toolchains"), without the patch version:
  `rust:1.100-alpine3.24`. If CI is behind the latest stable, bump both.
- **Alpine Linux:** Upgrade to the latest stable `3.NN`. Every stage that
  builds a binary and the stage that runs it must use the same Alpine version,
  so change all the `alpine3.NN` tags in a file together (`rust:1.NN-alpine3.NN`,
  `node:NN-alpine3.NN`, `alpine:3.NN`, `nginx:1.NN-alpine3.NN`). Leave tags
  without an Alpine version, like `nginx:1.30-alpine`, as they are.
- **Debian:** Use the current stable codename. The stage that builds a binary
  (`rust:1.NN-slim-<codename>`) and the stage that runs it
  (`debian:<codename>-slim`) must use the same codename: a binary built against
  a newer glibc does not run on an older one. When moving to a new codename,
  check that every package in `apt-get install` still exists in it
  (`https://packages.debian.org/<codename>/<package>`).
- **Node.js:** Use the current Active LTS major (`node:26-alpine3.24`). Moving
  to a new major goes in its own commit, and the frontend build must pass.
- **Other images (nginx, postgres, NATS, ...):** Upgrade to the newest release
  with the same tag shape (`nats:2.12-alpine` becomes `nats:2.15-alpine`). Stop
  and ask before changing the major version.

## 4. Verify

Build every Dockerfile you changed, from the directory its `COPY` paths are
relative to (usually the repository root):

```sh
podman build -f <Dockerfile> -t repo-maintenance-check .   # or: docker build
```

A failing `apk add` or `apt-get install` means a package was renamed or
removed in the new release: find its new name and fix it in the same commit.
If a build needs secrets or services that are not available locally, list it in
the report instead. Remove the image afterwards (`podman rmi
repo-maintenance-check`).

For every Compose file you changed, check that it is still valid and that every
image can be pulled:

```sh
docker compose -f <Compose file> config -q
docker compose -f <Compose file> pull
```

## 5. Commit

Use the subjects from `SKILL.md`, "Commit subjects", one commit per kind of
change, naming every version that changed in it:

```text
build(docker): upgrade Rust to v1.100
build(docker): upgrade Alpine Linux to v3.24 / Rust to v1.100
build(docker): upgrade Debian to Trixie
build(docker): upgrade Node.js to v26
build(docker): upgrade nginx to v1.30
build(docker): upgrade NATS to v2.15 and pin nats-box to v0.20.2
```

In the body, mention packages that had to be renamed and anything that changed
for the image at runtime.
