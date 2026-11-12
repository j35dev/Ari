# Aria project lead upkeep

Measured against immutable main `6f018a75`, before the experimental setting.
No lead behavior was removed. Source counts include physical lines containing
syntax, including multiline literals, and exclude blank/comment-only lines.
TypeScript AST leaf-token coverage counts each physical line once. Tests are
selected standalone `it` declarations, expanding literal `it.each` arrays;
their source counts exclude shared fixtures. This is a responsibility estimate,
not proof that all selected lines can be deleted independently.

| Separable lead-only code                                                                             | Source lines |
| ---------------------------------------------------------------------------------------------------- | -----------: |
| Engine `projects.ask`/`projects.lead` dispatch, `#askProject`, `#changeProjectLead`, `#projectLeads` |          171 |
| Contract `projects.ask` and `projects.lead` schemas                                                  |           32 |
| `isHelmProjectLead`                                                                                  |            3 |
| `REQUESTED_LEAD` and `projectLeadBrief` preamble                                                     |            8 |
| CLI `project ask` and `project lead` parsing                                                         |           32 |
| Total                                                                                                |          246 |

These blocks have 20 standalone lead-management tests: 17 engine Helm tests,
two preamble tests and one desktop CLI parser test. Their bodies contain 694
source lines. The counts are a conservative lower bound; scattered mixed
expressions, documentation and shared delegation machinery are excluded.

Another 52 source lines explicitly handle ancestry/subtrees: 21 in
`helmAttentionRecipient`, 21 in descendant/live-child handling in `helmRow`,
eight in descendant project occupancy and two adding Aria as an attention
recipient. Eleven mixed regression declarations expand to 13 cases and contain
638 test source lines. These also serve ordinary delegated trees, direct Aria
sessions with workers, or status views observing user-created trees, so they
are not wholly removable.

One plain session per task would lose persistent project lead context,
`project ask` reuse, lead selection across topics, lead switches/resets and
lead-owned worker integration. Flattening result/attention routing without
equivalent safeguards would hide worker questions and approvals or report a
root complete before its delegated work settles. Request ownership, durable
inboxes, acknowledgement recovery, settlement mirrors, stopped-turn handling
and orphaned topic routing remain necessary for ordinary delegation or direct
Aria sessions.

Reproduce the selected source from `git show 6f018a75:<file>` using these
one-based ranges on that exact commit:

```text
Source:
packages/engine/src/agent-control.ts              1014–1017, 1759–1932
packages/contracts/src/agent-control.ts           208–239
packages/contracts/src/helm.ts                    54–56
packages/engine/src/control-preamble.ts           43–44, 91–96
apps/desktop/resources/cli/ari.cjs                 162–175, 189–206

Standalone lead-test declaration lines:
packages/engine/src/helm.test.ts
  532,587,621,642,663,702,778,809,840,1025,1294,
  1508,1564,1596,1649,1671,2113
packages/engine/src/control-preamble.test.ts       232,241
apps/desktop/src/main/control-cli-parser.test.ts  187

Mixed cross-tree declaration lines:
packages/engine/src/request-supervisor.test.ts    172,244,482,671,683
packages/engine/src/delegation-supervisor.test.ts  718,751
packages/engine/src/helm.test.ts                   1352,1813,2324
apps/desktop/src/main/agent-runtime-coordination.test.ts 180
```

The project busy check compares project IDs, rather than effective workspaces.
Ordinary managed worktrees are already excluded, but an Aria root occupies its
project while any descendant runs, including isolated workers. Aria's top-level
launch also requires a project-folder workspace. A complete fix needs root
worktree support and occupancy checks against root/descendant workspace paths,
with shared-folder refusal, acquisition, cleanup, retries and restart tests.
Changing just the final project-ID comparison would be incomplete. That change
is outside this implementation.
