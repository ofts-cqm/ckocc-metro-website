# Map repository validation setup

This directory contains the validation gate to install into `ofts-cqm/ckocc-metro-map` during deployment. Nothing here has been uploaded or activated. Use an administrator identity to install `.github/workflows/validate-map.yml` and `scripts/validate_map.py`; the runtime bot intentionally lacks Workflows and Administration permissions.

The check executes validation code from the protected default branch and reads candidate files as data. It checks byte hashes, RMP graph references, PNG chunk CRCs and bounded decompression, the manifest revision, the recorded base commit/revision, and the path allowlist for ordinary map branches. For this personally owned repository, maintenance PRs must start with `maintenance/`, originate in the same repository, and be opened by its owner to change infrastructure files. Map checks still apply. Do not permit the runtime bot to bypass review or branch protections.

The ordinary `pull_request` workflow has a read-only token and no application secrets. Its check is attached to the PR. Protect workflow changes through administrator review; the bot's installation must continue to lack Workflows permission. The validator itself always comes from current `main`, and candidate scripts, dependencies, hooks, and actions are never executed. Before installing, pin the `actions/checkout@v7` references to the verified release commit. The action's usage is documented in its [official repository](https://github.com/actions/checkout).

After installing the workflow and observing its successful baseline run, require the `validate-map` check on `main`, require up-to-date branches, and require manual administrator review/merge. Re-test with two competing map PRs before declaring the protection complete. If another PR merges first, updating a stale PR branch must not erase its original `base_map_revision`.

Use two independent rulesets if supported: an identity rule restricting default-branch updates to administrators through PRs, and a validation rule with no bot/admin bypass for required checks. Setup of the first workflow is an administrator bootstrap operation; it cannot validate itself using a copy that does not yet exist on the protected branch.

The workflow is prepared for review. Deployment and test execution are deferred until the owner returns.

## Preparing a rollback later

Install `scripts/prepare_manifest.py` beside the validator. Create a new branch from current `main`, restore only the desired historical `maps/network.json` and `maps/network.png`, then run this command with the actual current base SHA:

```sh
python3 scripts/prepare_manifest.py --repository . --base-commit FULL_CURRENT_MAIN_SHA --contributor YOUR_DISPLAY_NAME --summary "Restore the previously reviewed map"
```

The command validates the pair and writes a fresh manifest; it does not commit or push. Review and commit all three `maps/` files together and open a PR. The validation gate checks the recorded base again. A plain revert of the old manifest usually contains an obsolete base and must not be used. Reopening previously resolved issues is a separate administrator decision. `--issue N` is available for recording selected issues, but this CLI does not create PR closing directives automatically.
