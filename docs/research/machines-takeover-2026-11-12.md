# Machines takeover

Integration resumed from clean `feat/machines` 9a9cb467 in
`D:/Projects/Ari-machines`. Read the frozen design, checkpoint, resume review,
worker handoffs, branch logs and actual diffs. The old sessions are closed;
existing D worktrees and all implementation were preserved. Grants' four WIP
files were assigned for review and commit first. The interrupted security
worktree holds a report-only audit through c83855e0.

Fresh workers use codex / gpt-6.1-sol, full permissions. Mobile access, parallel
session review and security use explicit high effort. Machines core, desktop
and mobile use explicit xhigh. All authoring is in the existing D worktrees;
the managed C launcher worktrees contain no installs/builds. No new integration
or feature worktree was created. No live Ari/Tailscale/settings/devices changes,
pushes or PRs are authorized.

The runner now admits two heavy steps when commit headroom is at least 6GB,
otherwise one. Floors remain C free 5GB and commit headroom 1.5GB. Admission is
atomic across both slots; active leases heartbeat, and live owners are never
reclaimed. Processes run below normal priority with D caches/temp. A gated
no-op completed successfully. Initial C free was 21.36GiB and commit headroom
16.07GiB. A read-only fetch confirmed origin/main remains 6f018a75.

The latest takeover brief supersedes the earlier F isolation rule: integrate
the parallel-session fix into feat/machines, while retaining
fix/parallel-project-worktrees based only on origin/main for separate shipping.

Initial source audit confirms S1-S4 and S7 corrections on authored branches.
Durable device-record persistence/load/restart denial (S5), receipt persistence
and corruption/pressure safeguards (S6), mobile read-only retry actions and
legacy unscoped-key origin binding require final worker and integrated evidence.
Security reviews the exact integrated snapshot before completion.

Remaining: accept each focused result, integrate/review all branches, final
security review, one wide typecheck/lint/suite/build pass and real two-engine/
two-gateway loopback proof, screenshot review, hardware/release checklist,
PR514-516 compatibility assessment and prompt worker/worktree cleanup.
