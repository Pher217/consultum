# Contributing

Thanks for considering a contribution to `askup`.

## Setup

```bash
npm install
```

## Running tests and lint

```bash
npm test        # node --test
npm run lint     # node scripts/lint.mjs
```

Both must pass before a PR is merged. CI runs the full matrix (Node 20/22 on Linux, macOS, and
Windows) with no live provider keys — tests run entirely against injected fakes.

## Adding a provider adapter

Provider adapters are the only place that talks to a model host. See
[`docs/adding-a-provider.md`](docs/adding-a-provider.md) for the contract, the rules enforced by
`test/providers.test.js`, and how to register a new adapter.

## Pull requests

- Include tests for any behavior change — a PR without tests will not be merged.
- Keep the diff focused; unrelated cleanups belong in a separate PR.
- Update relevant docs (`docs/*.md`, `README.md`) when behavior or config shape changes.

## Reporting security issues

**Do not open a public issue for a security vulnerability.** Report it privately through this
repository's GitHub Security Advisories (`Security` tab → `Report a vulnerability`). See
[`docs/threat-model.md`](docs/threat-model.md) for the project's trust boundaries and threat model.
