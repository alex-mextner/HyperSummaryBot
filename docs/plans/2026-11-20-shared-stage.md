# Shared isolated staging

Tracking: https://github.com/alex-mextner/HyperSummaryBot/issues/52
Shared implementation: https://git.hyperide.ai/ultrabricks/rig-cli/issues/980

The staged application is built and checked on an ephemeral hosted runner. A trusted Rig
controller validates the exact PR SHA, successful CI run and generated workflow blob, then
loads only the stage image into the existing shared stage host. The root receiver fixes
the container user, read-only filesystem, ephemeral database, network destinations,
resource limits and expiry independently of PR code.

The operator installs the reviewed manifest separately. The credential file contains only
the dedicated stage bot token; production environment files, AI keys, account sessions and
data volumes are never supplied. RIG_STAGE_LIMITED=true permits startup with unavailable
provider features. Ordinary production startup keeps its required configuration.

## Rollout

1. Pass the normal review and hosted CI gates for the shared Rig runtime and this diff.
2. Install the trusted receiver/controller on existing capacity with the independent reaper.
3. Provision a new dedicated stage token privately and verify its exact identity. This app has no existing stage token or poller to migrate; omit it from the live catalog until that prerequisite exists.
4. Inspect the new running container and execute the existing dedicated-chat smoke cases where provisioned.
5. This application has no provisioned browser QA fixture (`qa: false`). Report running isolation separately; do not claim a functional QA receipt.
6. Migrate trusted production deployment before retiring repository-assignable host runners.

## Rollback

Pause the controller and keep expiry active. Restore only a previously reviewed isolated
receiver or stage image; never restore a production environment into PR code. Production
processes and data are independent of this stage migration.

## Merge prerequisite and coverage migration

Rig task #980 must be merged and its reviewed CLI/receiver installed before this
application ships. Where functional QA is configured, the real receipt gate deliberately fails until that dependency
and the required dedicated-chat QA are available. The former inline deployment
and workflow guard contracts move to Rig artifact, policy, controller, runtime
and receipt tests; app tests bind the generated workflow, exact manifest, minimal
credential policy. Functional browser QA and a receipt-based ship gate remain
unprovisioned for this application; no functional QA success is claimed.

A dedicated HyperSummary stage token is not currently provisioned. The username in
the manifest is the intended dedicated identity; production tokens cannot be used
as a substitute. Its actual stage launch remains blocked until that token exists.
