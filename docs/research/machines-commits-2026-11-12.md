# Machines commit ledger — 2026-11-12

Base: `6f018a75`. Snapshot: `14c63b5e`. These 180 commits are reachable from
`feat/machines` and absent from the base, in reverse topological order. Each line
is one commit and its subject, including merges and preserved worker evidence.
The final verification/handoff and formatting commits follow this recorded
snapshot and are identified in the coordinator's final reply.

```text
527d443a docs: define Machines architecture and shared contracts
bde72ac5 docs: record Machines disk-gate checkpoint
b3de8de3 docs: record resumed Machines gates and review follow-ups
2d367ff6 chore: serialize Machines validation with a shared resource lease
f396e900 feat(tailscale): define alternate-port recovery and replacement contract
9df298a2 fix(tailscale): recover Serve without replacing foreign mappings
fab45d3f docs(tailscale): record final recovery verification
3da8ab4a docs: record parallel authoring and integrated Tailscale recovery
7df64fa3 wip: preserve Machines shared client and contracts draft
79584283 feat: publish Machines contracts and shared remote client
1282cdd7 docs: record worker handoffs and completed session cleanup
b78d9bc4 docs: record Machines boundary and lifecycle review follow-ups
e1ac1392 feat: preserve Machines operation failures across IPC
e23fd628 chore: include shared remote client in root lint checks
9a9cb467 docs: bind machine credentials to independently paired origins
2afa3454 chore: allow two gated Machines validation jobs
5252e975 docs: record resumed Machines swarm and updated integration rules
1477b80b chore: record bounded integrated Machines verification
1406bc60 fix: recheck resource admission before every verification step
3c413a35 fix: measure sustained resource failures independently of lease waits
12785557 WIP: admit root sessions by working folder and acquire isolated worktrees
1eb49dc9 Show the active worktree beside composer controls
c69a1494 Preserve attempted root creation and pin fixture line endings
52c81689 Keep tree follow-ups queued and guard resumed folder access and orphan cleanup
042ed4bb Cover physical folder aliases and publish root worktree selection
10d38fbe Use folder admission when reopening pristine sessions
b3281f16 Keep provider steering outside root admission and verify independent startup
2dbe24f8 Record focused type and validation commands for the standalone fix
96cf37ea Format the focused concurrency implementation and evidence
2c0339e0 Import the validation runner URL dependency explicitly
89b22dbd Document verified standalone root concurrency behavior and integration evidence
a26861db WIP: preserve lead root checkout recovery identity during independent review
77f9422d WIP: use complete session identity for safe root branch cleanup
5c7f359e Record branch cleanup review and focused security validation commands
f76359ce Pin cleanup collision regression to security reproduction IDs
3be07c1e Format focused root cleanup regressions and checks
d1422ebe Keep exact full-ID legacy branch compatibility in ownership assertion
54954bb8 Record final independent recovery and security regression evidence
ba5011e2 Merge branch 'fix/parallel-project-worktrees' into feat/machines
35f67c1f feat(tailscale): define alternate-port recovery and replacement contract
f6bf045d wip(mobile-access): preserve grants migration and settings implementation
aa513aba fix(mobile-access): preserve owned Tailscale mapping recovery
b17d5907 fix(tailscale): recover Serve without replacing foreign mappings
b2c84cdf docs(tailscale): record final recovery verification
527e294d fix(grants): retain restart compatibility and verify project refresh
2242d750 chore(mobile-access): prepare isolated Settings capture
f5ff81cc fix(mobile-access): resolve fixture React from desktop dependencies
7f6bffe7 test(grants): verify project-free approval and terminal decisions
82c94512 fix(mobile-access): capture a static isolated Settings fixture
6af91a96 chore(mobile-access): format grant changes and document verification
c1c4c5f5 test(grants): preserve migrated grants before registry loading
562a2181 chore(mobile-access): diagnose isolated browser navigation
72ee4684 fix(mobile-access): clarify saved-port repair beside other services
fa0c3f26 fix(mobile-access): reflect connection loss in pairing step status
5828c4ea chore(mobile-access): finalize focused helper formatting
52f98b3a fix(remote): fence lifecycle and expire managed terminal leases
63b602af wip(remote): preserve durable authorization and receipt safeguards
f2319167 fix(remote): fail closed on security record failures
21e6e091 fix(remote): finish terminal cleanup and isolate legacy phone keys
4fe8355d fix(remote): fence delayed managed terminal dispatch across shutdown
3cbbaaf8 fix(grants): preserve legacy migration during service construction
2521b2c6 docs(grants): record security recovery and bounded receipt policy
d63288ef chore(remote): mark watchdog terminal cleanup as asynchronous
9c433b23 test(remote): assert fail-closed authorization after exact device write failure
a63712b4 chore(remote): format final persistence regressions
d7e08444 docs(grants): record final focused checks and screenshot evidence
3be4d6fc Merge branch 'machines/mobile-access' into feat/machines
fa7dd3a9 wip: preserve Machines shared client and contracts draft
6ffb3874 feat: publish Machines contracts and shared remote client
bee71d79 wip: implement persistent Machines service and safe transport
f1463872 test: prove Machines over two real loopback engines
6e5e7504 test: cover public gateway identity and handshake capabilities
04d6ec16 fix: preserve Machines status and await real engine approval
f24a49bb fix: revoke remembered Machines credentials on removal
b0bb6ddb feat: preserve Machines operation failures across IPC
7119a5a6 fix: scope Machines stream lifetimes and preserve paired routes
02158cd7 security: bind Machines credentials to independently paired origins
4b8206da fix: cancel remote authorization and leases on lifecycle disposal
bdc4f70f docs: record Machines core APIs and loopback verification
ad7c4240 chore: keep credential persistence methods lintable
51d0d807 fix: preserve asynchronous credential failure semantics
b737d2f9 style: format Machines contracts and core implementation
23ba62d1 security: never resend mutations on absent command receipts
c403f50a test: keep absent mobile prompt receipts uncertain
8471f3f3 style: format uncertain receipt regressions
a5600bf8 security: activate desktop credentials only after sealed persistence
870022b0 security: renegotiate protocol and clear stale remote grants
438180bf test: prove independent keys and uncertain receipts over real hosts
7d18bb95 fix: contain unreadable Machines registry startup
1c285cf4 test: supply explicit Machines update stream parameters
2d1e6275 security: keep every refused receipt lookup uncertain
d4be8dbe style: format Machines startup regression
23882f50 fix: contain host identity persistence failures at startup
1d541ade test: retain receipt uncertainty across gateway compatibility versions
f6fb1fc6 style: format host identity failure regressions
32ae6d34 test: use valid local session list parameters in startup regression
1fd55aee test: type the public gateway identity response
e24656f4 test: handle nullable persisted sessions in receipt proof
bfd720a5 chore: keep receipt regressions lintable and IPC errors sanitized
53f1320c test: keep lifecycle proofs compatible with strict receipt restore
9ffe755b docs: record final core security evidence and integration commits
8bd66389 style: format final core verification evidence
fed49312 Merge Machines core with grant persistence and lifecycle guards
ab48e365 docs(mobile): record overhaul audit and verification plan
55231f04 test(mobile): add deterministic phone layout review fixtures
3a50f308 wip: preserve Machines shared client and contracts draft
a280cf07 feat: publish Machines contracts and shared remote client
d381950f test(mobile): isolate Vite review root and sequence focused checks
2b6fb2c9 feat(mobile): scope the public computer directory and local cleanup
77abebf5 wip(mobile): isolate computer connection state and preserve new drafts
465576ba feat(mobile): add computer switching and polish phone workspace navigation
5555520c fix(mobile): abort abandoned pairing before forgetting device state
6ed0900f test(mobile): finish focused checks and include typed layout fixtures
88e57871 fix(mobile): clear scoped fork receipts and show the session computer
08704cca fix: cancel remote authorization and leases on lifecycle disposal
20f6d1fe fix(mobile): forget credentials without waiting on an offline host
b7bede61 fix(remote-client): retain pre-redemption negotiation from shared context
68c08410 docs(mobile): capture phone overhaul evidence and list visible changes
90fde1b0 test(mobile): assert computer labels and align shared negotiation context
cc7bead3 test(mobile): verify final pairing and lifecycle compatibility
bd182168 security: never resend mutations on absent command receipts
3dd2c461 wip(mobile): make uncertain receipt recovery read-only
17213735 test(mobile): guard terminal recovery and abandoned attachments
3fa3efae fix(mobile): label receipt checks and cover recovery states
c03d78c6 style(mobile): format recovery implementation and fixtures
80378275 fix(mobile): type receipt assertions and enable the fork review fixture
a6a92c20 style(mobile): format final focused validation
62395705 fix(mobile): contain native fork selectors in phone sheets
679e0bd3 style(mobile): format inner-sheet capture checks
8b8d3f42 docs(mobile): record final recovery screenshots and validation evidence
f96a6819 Merge mobile overhaul while retaining origin-bound keys and safe receipt checks
5908f1e9 docs: record desktop Machines scope and verification plan
5f2a27c8 feat(desktop): add host-scoped Machines settings and client boundary
a58ff119 wip: preserve Machines shared client and contracts draft
d56573b9 feat: publish Machines contracts and shared remote client
bdaa05a2 feat(desktop): implement Machines sidebar and dedicated remote workspace
12c7d45c test(desktop): add deterministic Machines capture fixture
4b857885 fix(desktop): preserve newer drafts and reject stale host responses
dbae5218 feat: preserve Machines operation failures across IPC
1ec02f71 fix(desktop): persist host creation drafts and validate remote receipts
525a85a6 test(desktop): verify granted terminals and fix focused lint findings
5ce1d560 fix(desktop): retain receipts for uncertain named remote failures
08415210 fix(desktop): align fork results and link child action receipts
5b479bdf docs(desktop): document Machines behavior and workspace differences
92d29b6b chore(desktop): format Machines code and add focused typecheck target
4df7d3a9 wip(desktop): preserve Machines takeover review checkpoint
d5b77e68 fix(desktop): preserve scoped drafts through late host completions
41004786 test(desktop): automate isolated Machines fixture captures
be958760 chore(desktop): format scoped completion regressions and capture script
e87286d6 test(desktop): cover schema-rejected and uncertain receipt failures
10d716d0 fix(desktop): typecheck Machines component assertions correctly
ccee5cda fix(desktop): make saved remote action recovery strictly read only
773f23ee chore(desktop): format read-only recovery fixture and regressions
76809d74 test(desktop): capture the actual sidebar Machines group
d31608c4 fix(desktop): wait for compositor paint in isolated captures
df55732d fix(desktop): keep remote code readable in light themes
5a3a71e7 chore(desktop): format final painted capture automation
95683428 wip(desktop): preserve composer correction and painted Machines evidence
fb68823b chore(desktop): format focused composer capture assertions
c8f71c46 docs(desktop): record verified composer correction and refreshed evidence
e8a4e4e8 chore(desktop): finish formatted Machines integration handoff
418843f8 Merge Machines desktop workspace with current shared security boundaries
a16e785c style: format integrated lifecycle and validation changes
2e88b11d fix: preserve identity narrowing and import validation timers
9b98cbb4 fix(mobile): retain uncertain integration conflicts without resending
3f55df73 style(mobile): format integration receipt regressions
d26f529f wip: record initial Machines security findings
da35bbfe docs: expand Machines security audit and fix tracking
c83855e0 docs: record reproduced Machines route exploit and corrected boundaries
e27ccf9b wip: pin resumed Machines security audit snapshots
7fe52af9 docs: record reproduced root cleanup finding and security follow-ups
8a8b1660 docs: verify corrected Machines pairing and root cleanup boundaries
d86e3477 wip: pin final integrated Machines security review
f4bb8198 docs: complete final integrated Machines security review
4a7aae9e docs: integrate final Machines security review
3adf6212 test: provide occupancy result when reusing an empty session
14ade277 docs(mobile): record integrated receipt checks and refreshed recovery captures
28c6a04b docs: preserve complete Machines commit ledger
5010f950 test: provide occupancy result when reusing an empty session
14c63b5e Merge standalone occupancy fixture validation follow-up
```

Standalone Tailscale tip: `9df9d9ba`. Standalone parallel-session tip: `5010f950`,
which appends the six-line tested occupancy fixture correction to `54954bb8`.
Aria pushed `54954bb8` as draft PR #517; the fixture follow-up remains local.
