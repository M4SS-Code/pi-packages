---
name: commit
license: MIT
description: >
  Create safe, well-scoped Git commits from working-tree and staged changes.
  Use when the user asks to commit, amend, fold a fix into an earlier commit,
  review what should be committed, or draft a commit message. Inspects every
  candidate change, preserves unrelated work, follows the repository's explicit
  and implicit conventions, groups each change type into its own commit, runs
  focused checks, and writes English Conventional Commit messages.
---

# Commit changes safely

Treat the working tree and index as user-owned state. Preserve unrelated work
and create commits that are easy to review, revert, and understand later.

## Choose the operating mode

The user's request determines what may be changed:

| Mode                                  | Index changes                     | Commit/history changes                                                                                     |
| ------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Review what should be committed       | Forbidden                         | Forbidden                                                                                                  |
| Draft a commit message                | Forbidden                         | Forbidden                                                                                                  |
| Create a commit                       | Allowed for the approved scope    | Create new commits; may fold corrections into local, unshared commits created earlier in this session      |
| Amend the latest commit               | Allowed after amend-safety checks | Amend `HEAD` only                                                                                          |
| Fold corrections into earlier commits | Allowed after amend-safety checks | Amend (when target is `HEAD`) or fixup commit plus scoped `--autosquash` rebase of local, unshared commits |

Do not stage or commit during review-only or message-only work. When the user
asks to commit or amend, carry the workflow through without routine
confirmation. Stop and ask only when scope is ambiguous, suspicious content may
be intentional, verification fails, or history rewriting is not clearly safe.

## Non-negotiable rules

1. Inspect every staged, unstaged, and untracked candidate before acting. Prior
   staging is evidence of intent, not proof that a change belongs.
2. Include only changes covered by the user's request. Preserve unrelated,
   pre-existing, and uncertain work exactly as it is.
3. Follow the repository's conventions — both explicit policy and the implicit
   style sustained across its commit history — before falling back to this
   skill's defaults for commit granularity, grouping, message format, and
   verification.
4. Keep one commit per type of change: do not mix distinct types (`feat`,
   `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `style`, `chore`)
   in a single commit. Keep directly related tests, closely related
   documentation, generated output, and lockfiles in the commit that makes the
   change; give standalone test, documentation, or build/chore work its own
   commit.
5. Never commit credentials, secrets, dumps, logs, temporary files, or agent
   scratch artifacts.
6. Never add AI attribution, model names, generated-by text, or an AI
   `Co-authored-by` trailer.
7. Never bypass hooks, force-add ignored files, create an empty commit, rewrite
   public history, or force-push unless the user explicitly requests the exact
   action and understands its consequence.
8. Do not discard, restore, delete, or silently unstage user changes.
9. Never push to a remote unless the user explicitly authorizes that push in
   the current request. Committing, amending, or verifying does not authorize
   pushing, and a request to commit is not a request to push.

## Establish policy, state, and intent

Confirm the repository and inspect its state and commit history:

```bash
git rev-parse --show-toplevel
git branch --show-current
git status --short --branch
git diff --stat
git diff --cached --stat
git log --no-merges -n 50 --date=short --pretty=format:'%h %ad %s'
```

Stop if this is not a Git repository. If a merge, rebase, cherry-pick, or revert
is active, understand that operation before creating an ordinary commit.

Determine the conventions to follow by this precedence:

1. the user's instructions in the current request;
2. explicit repository policy (`AGENTS.md`, `CONTRIBUTING.md`, commit templates,
   hook or linter configuration, and package guidance);
3. the repository's implicit style — the dominant pattern sustained over time in
   commit history (also check `git log --no-merges -n 20 -- path/to/area` for
   the touched area and `git log --no-merges -n 15 --format=medium` when
   subjects alone are not enough), covering message format, language, casing,
   scope/subsystem prefixes, trailers, and how commits group or split tests,
   docs, and generated files; judge across a broad span of time rather than a
   short recent sample that a single PR, contributor burst, or bot batch can
   skew, and when the project's style clearly evolved, follow the current
   sustained norm;
4. this skill's defaults below.

When contributing to an existing or open-source project, matching its explicit
and implicit norms takes priority over this skill's defaults. Use the
conversation to define intent; never assume the whole dirty tree belongs to the
current task.

## Inspect every candidate

Inspect in two stages so large unrelated files do not consume context merely
because the tree is dirty.

First inventory every candidate and classify its state:

```bash
git diff --cached --name-status
git diff --name-status
git ls-files --others --exclude-standard
```

Then read the full patch for every change intended for the commit and every
candidate that is suspicious, mixed, or needed to determine scope:

```bash
git diff --cached -- path/to/candidate
git diff -- path/to/candidate
```

Read relevant untracked files individually. Do not skip a candidate merely
because it is unrelated; record its state and confirm it will remain untouched.
Do not load a huge unrelated file in full when its metadata and focused
inspection are enough to establish that it must be excluded.

For each candidate, determine:

- what changed and whether it belongs;
- whether it is staged, unstaged, untracked, or partially staged (or ignored, if
  the user explicitly named the path);
- whether it is generated, renamed, deleted, executable, a symlink, submodule,
  or binary;
- whether it introduces a breaking change to a public API, CLI, configuration,
  schema, or wire format;
- whether it contains credentials or accidental local data; and
- which logical commit, if any, it belongs to.

Treat unexpected binaries, archives, vendored trees, mass deletions, `.env`
files, keys, tokens, logs, dumps, coverage, editor metadata, debug output, and
agent artifacts as blockers unless their inclusion is clearly intentional.
Generated files and lockfiles are valid only when expected, tracked by project
policy, and reviewed.

Do not echo a discovered credential into the response or commit message. Use the
repository's secret scanner when available.

## Plan one commit per change type

Group by type of change first, then by logical purpose within a type, not by
file type or directory. Give each type of standalone work its own commit: a
feature, a fix, a refactor, standalone documentation, and standalone test,
build, CI, or chore work do not share a commit. Keep directly related tests,
closely related documentation, required generated output, and corresponding
lockfile or schema changes in the commit that makes the change. Order the
commits so each leaves the repository coherent — for example, a preparatory
refactor before the feature that depends on it, and standalone documentation
after.

Split independent behaviors, unrelated refactors, or changes that should be
reviewed, reverted, or bisected separately. Each commit should leave the
repository coherent and pass relevant checks when practical. If safe separation
requires guessing about ownership or manipulating uncertain partial staging,
ask the user.

In review-only mode, stop after reporting the proposed groups, exclusions,
risks, and suggested messages.

If the index already contains unrelated or uncertain staged changes, do not
create the requested commit and do not unstage them automatically. Ask whether
to include them, temporarily alter the index, or postpone the commit. Preserve
the index exactly while waiting for that decision.

## Stage deliberately

This section applies only to commit, amend, and fold-corrections modes.

Preserve the existing index. If the user already staged multiple in-scope
changes that must be split across planned commits, you may unstage and re-stage
them per commit group provided every pre-staged change is committed by the end
of the cycle. Prefer explicit paths or intentional hunk staging:

```bash
git add -- path/to/file path/to/other-file
git add -p -- path/to/mixed-file
```

Use `git add -A` only after reviewing the complete tree and confirming every
change belongs to one planned commit. Do not use `git add .` as a shortcut. Do
not use destructive commands to simplify staging.

Before every commit, run and inspect:

```bash
git diff --cached --stat
git diff --cached --check
git diff --cached
```

The cached patch must contain the complete logical change and nothing else. If
it is empty, do not create a commit unless the user explicitly requested an
empty commit.

## Verify the staged change

Run the smallest meaningful repository checks for the staged scope: focused
tests, formatting checks, linting, type checking, documentation checks, or a
targeted build. Follow documented commands when available.

Prefer check-only commands. Before running a formatter, generator, or other
mutating check, ensure its write scope cannot overwrite unrelated dirty work. If
that cannot be guaranteed, ask first. Inspect and stage any generated changes
deliberately.

If a relevant check or hook fails, keep the failure visible and ask how to
proceed. Never bypass it without explicit permission. After checks, re-run
`git status --short` and review the cached patch because tools and hooks may
change the tree.

## Write the message

Follow the repository convention established earlier. When using this skill's
English Conventional Commit default, format the message as:

```text
<type>(<scope>)[!]: <imperative summary>

<optional body>

<optional footer(s)>
```

Use the narrowest useful stable scope, or omit it when none is honest. Common
types are `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`,
`chore`, `style`, and `revert`. Choose the type from purpose, not file extension;
avoid `chore` when a more precise type applies.

The subject must:

- use imperative mood;
- mark any breaking change with `!` immediately before the colon
  (for example `feat(api)!: ...` or `refactor!: ...`);
- begin with a lowercase word after the colon (unless it is a proper noun,
  acronym, or identifier);
- omit the final period;
- stay at or below 72 characters; and
- state a concrete outcome rather than "update," "changes," or filenames.

Add a body only when it explains motivation, user-visible impact, trade-offs,
compatibility, migration, or durable rationale that the subject cannot. Do not
narrate the diff. Separate it with a blank line and wrap prose at 72 characters.
When a commit introduces a breaking change, always include `!` before the colon
in the subject and explain what broke and how to migrate in the body or a
`BREAKING CHANGE:` footer.

In message-only mode, base suggestions only on the inspected diff and stop after
returning the proposed message; do not stage or commit. Use the staged diff when
the index is non-empty. If staged and unstaged changes represent different
purposes and the user did not identify one, ask which patch the message should
describe.

## Commit and verify

For each logical group, commit only after its cached patch and checks pass. Then
verify what Git recorded:

```bash
git show --format=fuller --stat --patch --no-ext-diff HEAD
git status --short
```

Read the recorded message and patch. Hooks may alter files or messages. Repeat
the stage, review, verification, commit, and post-commit inspection cycle for
each additional group. If a later group or check reveals that a change belongs
to an earlier commit made in this session, fold it in as described in "Fold
corrections into earlier commits" instead of leaving a separate cleanup
commit.

Report each commit with its short hash, exact subject, and one sentence
summarizing its contents. Mention remaining changes only when they need the
user's attention, especially intentional exclusions or suspicious files. Do not
push afterward; pushing is a separate action that requires explicit
authorization.

## Amend only when history safety is established

Amend only when requested or when a correction clearly belongs to a commit just
created in this session. Confirm that `HEAD` is local and unshared:

```bash
git branch --show-current
git status --short --branch
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null
git log --oneline '@{upstream}..HEAD' 2>/dev/null
```

Do not infer safety from a missing upstream. Avoid amending `main`, `master`, a
protected branch, or any branch that may be shared. Ask when uncertain.

Before `git commit --amend`, review the complete result: existing `HEAD` plus the
staged patch. Preserve the message with `--no-edit` only when it still describes
the whole amended commit; otherwise rewrite it. Do not rebase, reset, or
force-push as an incidental part of amending; the only other history rewrite
this skill performs is the scoped `--autosquash` rebase described in "Fold
corrections into earlier commits".

## Fold corrections into earlier commits

You may discover mid-session that a change belongs to a commit already made in
this session: a missed hunk of a fix, a test, a closely related documentation
tweak. Fold it into that commit instead of leaving a separate cleanup commit.

First confirm the target commit is local, unshared, and created in this session
(or explicitly identified by the user) using the amend-safety checks above. Stop
and ask when the target may be shared. Then choose the mechanism by where the
target sits:

- **The target is still `HEAD`:** stage the correction and `git commit --amend`
  it.
- **The target is earlier than `HEAD`:** stage the correction and create a
  fixup commit:

  ```bash
  git commit --fixup=<target-hash>
  ```

  Then fold it into the target with a scoped autosquash rebase once the tracked
  working tree and index are clean:

  ```bash
  GIT_SEQUENCE_EDITOR=: git rebase -i --autosquash <base>
  ```

  `<base>` is the parent of the earliest commit being rewritten — typically the
  upstream tip or the ref where this session's work began.
  `GIT_SEQUENCE_EDITOR=:` accepts the pre-ordered todo list without opening an
  editor. The rebase still stops on conflicts; resolve them and
  `git rebase --continue`, or `git rebase --abort` to restore the pre-rebase
  state when the fold is not worth the trouble.

`git rebase` requires a clean tracked working tree and index. If other planned
commit groups remain in this session, leave the `fixup!` commit in place and
run one autosquash rebase after the remaining groups are committed. If
unrelated tracked changes are dirty in the working tree or index, do not stash
or alter them silently; leave the `fixup!` commit in place and ask the user how
to proceed. Never push or share a history that still contains `fixup!` or
`squash!` commits, and never force-push a rebased branch without explicit
authorization.

After a rebase, re-verify with `git status --short`, `git show` on the
rewritten commits, and the checks that apply to the folded change.

## Adversarial staging example

Suppose the tree contains:

- staged `src/cache.rs` from unrelated prior work;
- unstaged `src/auth.rs` and `tests/auth.rs` for the requested fix; and
- untracked `.env` containing local configuration.

Do not commit. The existing staged file is outside the requested scope and must
not be silently unstaged, while `.env` is suspicious and must never be staged
without clear intentional handling. Preserve the index, report both blockers,
and ask how the user wants to handle the unrelated staged change. Do not echo
any `.env` values.

## Stop conditions

Stop and ask rather than guessing when:

- ownership or scope is unclear;
- staged work is unrelated or cannot be separated safely;
- a likely secret, suspicious artifact, unexpected binary, or mass deletion is
  present;
- relevant checks or hooks fail;
- repository guidance conflicts or grouping is materially ambiguous;
- amending may rewrite shared history;
- a correction would have to be folded into a commit that is shared or cannot
  be identified as this session's work, or rebasing is blocked by unrelated
  dirty tracked files;
- a request implies publishing or updating a remote without explicitly
  authorizing `git push`; or
- the requested action would require discarding work, force-adding ignored
  files, bypassing safeguards, or creating an unrequested empty commit.
