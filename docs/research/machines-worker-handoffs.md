# Worker handoffs and cleanup

Seven finished/superseded Ari worker sessions were archived and destroyed on
2026-11-11, at the user's request to reduce session-list crowding. Before each
destruction, the coordinator confirmed no active turn or queued message and a
clean Ari-managed C: worktree at the original 20409cba workspace snapshot. No
implementation existed only in those launchers. Reports and conversation context
were archived under D:/Projects/.ari-cache/worker-archives; implementation and
research handoffs are preserved in this repository and the assigned D: branches.

| Removed session | Preserved handoff |
| --- | --- |
| Tailscale address recovery | cfa56105 and b63c309f on fix/tailscale-serve-recovery; final validation superseded by the fresh worker's evidence |
| Finish Tailscale recovery | 9df9d9ba evidence: 69 focused tests, desktop/contracts typecheck, scoped lint and formatting; A reviewed/integrated as f396e900, 9df298a2 and fab45d3f |
| Mobile access and grants | D: code handed to Finish mobile access and saved there; all-project/Connect/terminal/settings follow-ups are in machines-resume-review.md |
| Machines protocol and core | Shared extraction draft preserved as fa7dd3a9/6ffb3874, reviewed/integrated as 7df64fa3/79584283; Build Machines core owns continued implementation |
| Machines desktop workspace | Design, result-schema/event/terminal-grant decisions preserved in the design and resume review; Build Machines desktop owns authoring |
| Mobile workspace overhaul | Original brief/audit skill and key-store compatibility instructions passed to Build mobile overhaul |
| Parallel project worktrees | Managed-root worktree/occupancy/acquisition/restart research passed to Build parallel sessions; separate branch remains independent |

Five active workers continue, one per D: worktree: Finish mobile access, Build
Machines core, Build Machines desktop, Build mobile overhaul, Build parallel
sessions. Those D: worktrees are retained. The completed Tailscale branch's
patches are all integrated (git cherry reports all three commits as present),
so its Git worktree registration was removed. Git could not delete the entire
D:/Projects/Ari-machines-wt/tailscale directory, and subsequent native recursive
cleanup was rejected by automatic tool policy with the reason "blocked by policy".
Remaining files in that unregistered folder are a cleanup follow-up; its branch
and integrated code remain safe. No alternative deletion bypass was attempted.

All active workers use codex/gpt-6.1-sol with full permissions; mobile access
uses high effort and the other four use xhigh. Authoring is parallel. Installs,
tests, lint, typecheck and builds share the atomic .heavy.lock lease and the
resource gate defined in docs/design/machines.md. Future worker sessions are
removed promptly after their verified branch is integrated.
