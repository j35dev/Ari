# Machines T3 parity independent security review

Status: authored-source audit in progress; no integrated certification.
Reviewer: fresh Ari review session, codex / gpt-6.1-sol, xhigh effort, full permissions.
Date: 2026-11-12. Review worktree: `D:/Projects/Ari-machines-wt/security`, branch
`machines/security-review`. Existing untracked `.review-temp/` is preserved.

## Pinned scope

| Role | Immutable commit |
| --- | --- |
| Current integration | `2c75d8fb75300f3760243d5a9a29fa99236d55a2` |
| Routes author | `379ef67b3a3a14877cea2ac39cffc0633bebf6f1` |
| Host author | `4f7125e45b2096c5b2c1647ed744ff06aa2d92f8` |
| Session author | `869d3bc88a342844aa2fcf647a64ba859c6ffb67` |
| Shell author | `eac1173b83629672c0d6e870cccd9c75745b818f` |

Read controlling brief `machines-t3-parity.md`, integration `docs/design/machines.md`,
`docs/research/machines-parity-contracts.md`, and prior
`docs/research/machines-security-review.md` S1-S9 and limitations. Historical source
closure and tests in that report apply to its named snapshots only. These authored
heads have different merge histories; a branch comparison is not an integrated result.

Source review reads immutable Git objects. Only review/evidence documents are edited.
No runtime code, user checkout, installed/live Ari, real profile/settings, Serve mapping,
push or PR is touched. No additional workers are launched. Heavy verification, if
needed, will follow a committed WIP checkpoint and the shared below-normal resource
runner using D: fixtures, one worker, C >= 5 GiB and headroom >= 1.5 GiB gates.

## Disposition

Pending source audit of route authority/credentials, replay, grants, normal SessionClient
ownership, Auto/drafts, host sanitization, backward compatibility and F invariants.
The coordinator must supply the final integrated SHA before the final merged audit.
Source closure, authored regression assertions, independent executed proof and
real-hardware checks will be recorded separately.
