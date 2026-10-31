# Contributing to Ari

Thanks for helping build Ari — a local-first agent development environment.

## Before you start

For substantial features or refactors, open a GitHub issue first to discuss the
scope and approach.

## Development

See [README.md](./README.md#quick-start) for prerequisites and installation.
From the repository root:

```sh
pnpm install
pnpm dev           # launch Ari Dev with a separate profile
pnpm verify        # typecheck, lint, and test every package
pnpm test:watch    # run tests in watch mode
pnpm format        # format the code
```

## Pull requests

- Keep each PR focused on one change and match the existing code style.
- Add or update tests for changed behavior.
- Run `pnpm verify` before pushing.
- Use conventional commit messages, such as `fix(ui): Preserve scroll position`.
- Explain what changed, why, and how you verified it in the PR description.
- Do not force-push shared branches; leave merging to the maintainers.

## Good first issues

Documentation, copy improvements, small UI fixes, and tightly scoped bugs are
useful places to start.

## Bugs and questions

Open a GitHub issue. For bugs, include your Ari version, operating system,
reproduction steps, and relevant logs with credentials and private content removed.
