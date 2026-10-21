# Map repository validation setup

This directory contains the validation gate for the map data repository. The owner confirmed the current application is deployed; these are reusable installation instructions, not a claim that the deployed gate is pending. See [deployment procedures](../DEPLOYMENT_TESTING.md#github-and-map-repository-setup) and the [technical specification and evidence](../TECHNICAL_SPEC.md#github-operations-merging-and-rollback). For a new installation, use an administrator identity to install `.github/workflows/validate-map.yml` and `scripts/validate_map.py`; the runtime bot intentionally lacks Workflows and Administration permissions.

The check executes validation code from the protected default branch and reads candidate files as data. It checks byte hashes, RMP graph references, PNG chunk CRCs and bounded decompression, the manifest revision, the recorded base commit/revision, and the path allowlist for ordinary map branches. For this personally owned repository, maintenance PRs must start with `maintenance/`, originate in the same repository, and be opened by its owner to change infrastructure files. Map checks still apply. The website confirmation supplies administrator approval; do not permit the runtime bot to bypass required validation or freshness protections.

The ordinary `pull_request` workflow has a read-only token and no application secrets. Its check is attached to the PR. Protect workflow changes through administrator review; the bot's installation must continue to lack Workflows permission. The validator itself always comes from current `main`, and candidate scripts, dependencies, hooks, and actions are never executed. Before installing, pin the `actions/checkout@v7` references to the verified release commit. The action's usage is documented in its [official repository](https://github.com/actions/checkout).

After installing the workflow and observing its successful baseline run, require the `validate-map` check on `main`, require up-to-date branches, and require administrator review through the website confirmation or GitHub. For website merging, permit the application to merge PRs and use no separate required GitHub approval. Re-test with two competing map PRs before declaring the protection complete. If another PR merges first, updating a stale PR branch must not erase its original `base_map_revision`.

Use two independent rulesets if supported: an identity rule restricting default-branch updates to administrators and the website application through PRs, and a validation rule with no bot/admin bypass for required checks. Setup of the first workflow is an administrator bootstrap operation; it cannot validate itself using a copy that does not yet exist on the protected branch.

For each installation or protection change, record the competing-PR and rollback results beside the specification. Existing dated acceptance evidence is in the technical specification.

## Website controls

Give the application Checks read permission alongside its existing map-writing permissions. Enable merge commits and require `validate-map` from GitHub Actions with strict up-to-date branches and no validation bypass. Only after the competing-PR and rollback acceptance checks pass, set `WEBSITE_MERGES_ENABLED=true` in the website environment. The application checks protection is enabled and the validation result is successful; the operator must verify strict freshness and bypass settings during deployment.

Administrators can create a rollback PR from any website-created merged update on the Updates page. It restores the complete map from before that update and regenerates the manifest against current HEAD. Subsequent changes are removed only when the new PR is separately merged. The manual procedure below remains available for other historical map changes.

## Preparing a rollback manually

Install `scripts/prepare_manifest.py` beside the validator. Create a new branch from current `main`, restore only the desired historical `maps/network.json` and `maps/network.png`, then run this command with the actual current base SHA:

```sh
python3 scripts/prepare_manifest.py --repository . --base-commit FULL_CURRENT_MAIN_SHA --contributor YOUR_DISPLAY_NAME --summary "Restore the previously reviewed map"
```

The command validates the pair and writes a fresh manifest; it does not commit or push. Review and commit all three `maps/` files together and open a PR. The validation gate checks the recorded base again. A plain revert of the old manifest usually contains an obsolete base and must not be used. Reopening previously resolved issues is a separate administrator decision. `--issue N` is available for recording selected issues, but this CLI does not create PR closing directives automatically.
