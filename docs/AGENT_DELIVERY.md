# Agent task delivery

This is the completion procedure for coding agents working in VinylHound.
[AGENTS.md](../AGENTS.md) makes it mandatory for both Codex and Claude. It is an
agent responsibility during task execution; it does not install an unattended
GitHub bot or scheduled monitor.

## Task identity and commits

1. Read the relevant roadmap milestone and identify the phase, milestone, and
   task. P4.2 Task 3 has ID `p-4.2.3`. Preserve existing task numbers.
2. Add newly scoped work to the appropriate milestone when it fits. For unplanned
   work without a roadmap home, reserve phase 0 / milestone 0 and use the task's
   GitHub issue number: issue #42 becomes `p-0.0.42`. This is a maintenance
   namespace, not a new product-delivery phase. Record the mapping in the issue
   and handoff; never borrow an unrelated roadmap ID.
3. Keep one task per commit and push each completed task before moving on. The
   entire subject must match `p-<phase>.<milestone>.<task>` (lowercase `p`, one
   hyphen, three dot-separated numbers). Example subject: `p-4.2.3`. Put the
   readable description, validation, and issue links in the body. Follow-up
   corrections to the same task retain its ID in separate commits.
4. Inspect `git status` and the staged diff. Preserve unrelated work, run the
   required checks, and update the handoff before committing. Do not create
   empty commits just to number a task with no repository changes.
5. Push a task branch and open/update a pull request when needed to trigger
   validation. Respect repository protection and contributor guidance. Do not
   force-push, bypass protection, or merge just to obtain a run. If a merge is
   separately authorized, preserve the task ID as the squash commit subject;
   the PR can retain its conventional descriptive title.

Creating task/follow-up issues, publishing the task branch and PR, and monitoring
checks are authorized by the maintainer's delivery rule. A task-specific limit
such as "local only" or "do not push" takes precedence; record the exception.
Manual cloud activation and protected deployment approval still follow their
existing operational gates.

## Outstanding manual tasks

Create or update an issue as soon as a required manual step is identified and
before ending the task. This includes real-device validation, human usability
sessions, account/secret/variable setup, environment approvals, and operational
rehearsals that the agent cannot complete. A proposed future feature does not
automatically make every possible future test an outstanding required task.

Search open issues by task ID and the actual work, including older title formats.
Reuse an issue that covers the same action; add newly discovered prerequisites
or evidence to it. Do not create a second issue just because the title differs.
Use separate issues for independently completable manual actions; a cohesive
rehearsal can have a checklist in one issue. Existing examples include issues
[#19](https://github.com/jessig1/vinylhound_new/issues/19) and
[#20](https://github.com/jessig1/vinylhound_new/issues/20).

Each issue must contain:

- Related task ID and the reason a manual action remains necessary.
- Required access, device/environment, and prerequisites without secret values.
- Exact steps or a link to the authoritative runbook, and safe cleanup if needed.
- Expected outcome and the sanitized evidence that proves completion.
- Whether it blocks acceptance, deployment, or neither.

Link the issue in the relevant roadmap task and `docs/HANDOFF.md`. Keep the
manual checklist open until the evidence exists; implementation completion does
not prove a rehearsal was performed. If GitHub is inaccessible, preserve the
complete issue draft and access blocker in the handoff for the next session.

## Monitoring GitHub Actions

After every task push:

1. Record the actual pushed SHA (`git rev-parse HEAD`) and confirm the remote
   branch points to it. Inspect workflow triggers and PR checks to determine
   which runs are expected. Reuse the current PR instead of opening duplicates.
2. List the runs for that SHA, for example:
   `gh run list --repo jessig1/vinylhound_new --commit <sha>`.
   Inspect an individual run with `gh run view <run-id> --repo
jessig1/vinylhound_new`. Use structured JSON when selecting runs and inspecting
   jobs. Include workflow-dispatched downstream runs when the task's delivery
   path triggers them; verify they actually deploy/test the intended revision.
3. Poll until all applicable workflows finish. Keep user updates flowing while
   waiting. Re-enumerate runs before concluding so a delayed workflow or rerun
   is not missed; inspect the latest attempt and relevant job conclusions.
4. Treat success as verified only when all applicable checks have succeeded.
   Explain skipped jobs that are intentionally conditional on event, file
   changes, repository visibility, or configured environments. A skipped
   deployment is not a deployment success; a missing required run is not a
   successful skip. A permitted check skip is not proof its underlying test ran.
5. `failure`, `timed_out`, `action_required`, and unexplained cancellation or
   startup failure require investigation and a tracking issue. A run superseded
   by a newer commit is not itself proof of a product defect, but the newer
   applicable run still needs verification. Pending, queued, waiting-for-approval,
   or missing runs leave delivery pending; investigate stuck/missing runs and
   file the failure or manual-action issue appropriate to the blocker.

Currently CI, Security, and Platform run for PRs and pushes to `main`.
Deploy development also runs on `main` pushes. A task-branch push alone does not
trigger those PR workflows until a PR exists. Staging and production deployment
are manual: do not activate cloud environments solely to make a docs PR green.
Read `.github/workflows/` each time; this inventory is not a substitute for the
actual triggers. Also check any required status checks outside Actions.

## Pipeline failure issues

Create the issue when a failure is observed, even if it seems unrelated to the
task, was previously intermittent, or will be retried. First inspect the failing
job/step and search for an open issue matching the failure cause. Update that
issue with the new occurrence rather than creating one issue per run. Distinct
causes need distinct actionable issues. Do not label an uninvestigated symptom
as a confirmed root cause.

Include the task ID, full SHA, branch/PR, workflow and run attempt, run/job URLs,
failing step, sanitized error excerpt, reproduction context, known/unknown cause,
and a concrete fix/verification checklist. Use existing appropriate labels.
Never publish tokens, raw user data, complete signed URLs, or security exploit
details; follow [SECURITY.md](../SECURITY.md) for sensitive findings.

Fix failures caused by the task within its scope, push the correction, and
monitor again. Leave broader failures tracked for follow-up rather than silently
expanding the task. A rerun becoming green does not establish that an intermittent
failure was fixed: retain the evidence and close the issue only when its stated
acceptance criteria are met. Do not skip a failing test or weaken a workflow to
claim success.

## Handoff and completion

Before committing, update the handoff with implementation state, local checks,
manual issues, and the delivery work still pending. After the push, record exact
SHA/run outcomes and issue links in the associated PR/task issue and final user
response. The handoff should point to that durable GitHub record for post-push
results; do not create an endless series of commits solely to insert each new
commit's own SHA or rerun URLs into the handoff.

Report implementation and delivery separately when a manual gate or failed
pipeline remains. If credentials, connectivity, runner availability, or approvals
prevent completion, state the evidence and resume action. Never claim an issue
was created, a commit pushed, or a pipeline healthy without verifying it.
