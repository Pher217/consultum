# CI workflow

`ci/ci.yml` is the GitHub Actions workflow for askup (node 20/22 · lint + full test suite · no live
keys). It is parked here rather than at `.github/workflows/ci.yml` because the branch was pushed by a
token without the `workflow` OAuth scope, which GitHub refuses to let create workflow files.

**To enable CI**, move it into place with a `workflow`-scoped credential and push:

```bash
git mv ci/ci.yml .github/workflows/ci.yml
git commit -m "ci: enable GitHub Actions workflow"
git push
```
