# Contributing

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/M4SS-Code/pi-packages.git
cd pi-packages
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Install into pi (local)

Use `pi install` with a local path to register each extension for development:

```bash
pi install ./packages/binary-file-guard
pi install ./packages/llms-txt
pi install ./packages/search-delegator
pi install ./packages/staan-search
pi install ./packages/web-fetch
```

## Development

```bash
pnpm run check:all    # type-check all packages
pnpm run format       # format all files
```

## Issues and Pull Requests

You are responsible for what you submit. We don't care whether you wrote it yourself or used an AI; we care that it's good.

Every issue and PR must start with a short **Intent** section that clearly answers:

- **What** problem are you solving?
- **Why** does it matter?
- **Who** is it for?

**Example:**

> **Intent:** When the LLM tries to read a PDF, SQLite database, or archive, it dumps binary garbage into context instead of getting useful text. I want an extension that intercepts the read call, detects problematic files, and tells the model to use bash with the right CLI tool instead. This affects every user who works with non-text files in their projects.
>
> I'm proposing a package rather than a skill because a skill adds overhead to the model's context and relies on the model remembering to read it. A package runs automatically on every read call with zero context cost.

Don't lead with the "how." Put the implementation details in the body; the first thing we need to know is _why_ the change exists. If the intent isn't clear, we may close the issue/PR and may ban the user.
