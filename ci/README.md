# CI workflow — one command to enable

`ci/ci.yml` is the GitHub Actions workflow for consultum: ubuntu/windows/macOS x Node 20/22, running
`npm ci`, `npm run lint`, `npm test`, with `permissions: contents: read`.

It is parked here rather than at `.github/workflows/ci.yml` because GitHub refuses to let a token
without the `workflow` OAuth scope create or update workflow files. This is a credential limit, not
a design choice — CI does not run until it is moved.

**To enable it:**

```bash
gh auth refresh -s workflow          # one-time, opens a browser
git mv ci/ci.yml .github/workflows/ci.yml
git rm ci/README.md
git commit -m "ci: enable GitHub Actions workflow"
git push
```

Windows coverage matters here: the project documents Windows support in `docs/windows.md`, and
until this workflow runs, that support is asserted but never tested.
