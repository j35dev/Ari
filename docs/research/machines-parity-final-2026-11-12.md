# Machines desktop parity, 2026-11-12

Historical completion and correction record. The subsequent clean full pass,
reviewed packaging fixes, refreshed captures and authorized PR publication are
recorded in [Machines publication, 2026-11-13](machines-publication-final-2026-11-13.md).
The no-push handoff below describes the earlier instruction and has been superseded.

Integration: `feat/machines`, `D:/Projects/Ari-machines`. Desktop core parity is
complete. Final runtime source is `da40bbef99343f9dce054889cb336e7ba3977e25`;
later commits contain fixtures, security reports and verification evidence.

The normal project draft now selects its execution machine under the composer.
The selected host supplies providers, models, effort, permission choices and
saved defaults. First Send creates on that host; existing sessions retain their
host permanently. Repository clones share one normal sidebar group, and remote
sessions use the normal transcript/composer, Changes, files, terminals and split
panes through a scoped SessionClient. Unsupported controls remain disabled with
their reason. No remote operation falls back to the client engine or filesystem.

Headless hosting and remote update execution remain designs. The desktop exposes
version/capability negotiation and host update guidance. See the 43-row
[parity matrix](../design/machines.md) and the complete
[headless design](../design/machines-headless.md). The read-only T3 evidence anchor
is `pingdotgg/t3code` at `6577c6b6185167c0e502fa01f9e8e8f2dee6ff25`; behavior
was studied and implemented in Ari's architecture without copying T3 source.

## Desktop changes

Removed `RemoteWorkspace`, `MachineChooser` and `RemoteMachineGroups`, including
the separate Remote computers sidebar and navigation. Reusable receipt transport
and host-scoped recovery remain. New drafts offer This PC, eligible saved hosts
and Auto; offline/incompatible hosts are disabled with a reason so their saved
presence remains visible. There is no cloning onto another host.

The host is fixed after branch/worktree selection and after creation. Last manual
choice is retained per repository only while usable. Offline sessions retain the
last-known transcript read-only in the normal view with reconnect guidance.
Explicit revocation/removal/identity mismatch purges watched host caches; late
responses cannot restore them. Remote host/status labels appear below sidebar
titles and in the normal header; local sessions have no additional badge.

Machines settings has a usable Add computer button, action-based Rename, Ari
version/status, ordered Routes and Your permissions. This PC's inbound phones
and computers remain in Mobile access. Terminal access remains an explicit host
grant; client-side preferences cannot widen it.

## Repository identity

Hosts select a usable network fetch remote named `upstream`, then `origin`, then
the deterministic first other remote. Canonical identity follows that remote.
A differing usable `origin` supplies the grouping key and fork label, so separate
forks do not collapse into upstream or one another.

Normalization produces a lower-case hostname/repository-path key. HTTPS, HTTP,
SSH URL, git URL and SCP-style SSH spellings correlate; scheme and port do not
form part of repository identity. Leading/trailing slashes and the final `.git`
suffix are removed. Userinfo, query and fragment never appear in metadata.
Azure `ssh.dev.azure.com:v3/org/project/repo` maps to
`dev.azure.com/org/project/_git/repo`. Other host aliases remain literal and
separate. Local/file remotes, invalid locators and repositories without a usable
network remote remain scoped to the exact machine/project, with machine labels.

Two checkouts on one host remain explicit checkout candidates; Ari never guesses
their filesystem path. Lower-case paths and omitted ports follow the selected
T3 correlation rule: unusual case-sensitive or multi-port Git hosting can group
distinct repositories visually. Correlation grants no authority, chooses no
host and moves no files or sessions. Unknown host aliases can instead produce
separate groups. These edge cases are a product policy to confirm.

First-run setup also opens this normal project draft. It imports the chosen
projects and saves setup/defaults, then shows the machine selector before any
session exists. Durable session creation and first prompt remain owned by the
same first-Send facade; reopening setup preserves an established draft/session.

## One-way pairing, routes and Auto

Pairing this PC to B requires approval on B by displayed name and confirmation
code. It grants this PC access to B only. Reverse access requires a separate
pairing approved on this PC. There is no group or transitive access. B's
revocation removes that direction and its derived route tokens on B; an
independent grant on A survives. Discovery and repository matching never approve
devices. An address not already associated with a saved host uses Add route.

A stable local registry ID is separate from host signing identity and addresses.
The original approved origin establishes the signing pin. Additional origins
come from an authenticated signed host manifest, with source credential
provenance and durable monotonic issuedAt ordering. Equal-time reports only
intersect authority, and stale reports cannot restore removed learned routes.
User routes persist; learned routes follow authenticated reports and cannot be
manually removed. Both can be reordered.

Each candidate passes an anonymous fresh descriptor/nonce proof for the pinned
key and exact origin before device proof or credentials. Host audience comes
from its own configured gateway/owned Serve exposure, never client headers.
Authorization yields a route-specific bearer; the original bearer never crosses
origins. Production retains verified Tailscale HTTPS, DNS/TCP pinning, no
redirects and no HTTP downgrade. LAN/relay remain out of scope. Legacy unpinned
origins retain independent approvals.

Ordered fallback and authorized foreground/network/minute prechecks change only
transport. Move-back is cooled down and preserves the existing session owner,
cursor and live-turn fence. Removed-route generations abort late proof/setup.
Unknown commands retain their exact receipt and permit only status checks;
reconnect never resends a mutation or substitutes another host.

Auto is available and off by default. This PC starts selected. Prefer, Normal,
Less often and Manual only are client preferences; Manual only excludes Auto
while allowing explicit selection. Samples are authenticated, demand-only and
memory-only. Eligible hosts must have the project, usable catalog and current
grant, be compatible/connected, have a sample no older than 30 seconds, CPU below
85%, at least 1.5 GiB available memory and at least 10% available/total memory.
Preference tier wins, then lower CPU, more available memory and stable ID.
The resolved host/reason stays fixed; choosing Auto again rechecks. Pre-Send
samples only the fixed Auto host. Missing/busy resources retain the draft and
request manual selection, without silently queuing or switching machines.

Identity initialization now flushes complete records before no-replace
publication, retains one recovery winner across competing initializers and
keeps the primary on a separate inode. Valid legacy IDs anchor unchanged.
Missing primary reuses the anchor; only an anchored empty primary can restore,
retaining empty evidence. Invalid/unanchored files and inconsistent recovery
records block hosting. Existing signing-key/established-anchor checks refuse
silent reset. Windows directory durability and OS profile ownership remain
platform/hardware verification limits, not a new headless runtime.

## Screenshots

Normal-component Electron fixtures use fake RPC, an isolated D: profile, no
external requests and no command mutations. These are desktop component
evidence, not photographs of two real tailnet computers. All 16 PNGs and capture
assertions are in [desktop-machines-parity](evidence/desktop-machines-parity).

| Surface | Light | Dark |
| --- | --- | --- |
| Open machine selector | [Light](evidence/desktop-machines-parity/machines-picker-light.png) | [Dark](evidence/desktop-machines-parity/machines-picker-dark.png) |
| One project, sessions on multiple machines | [Light](evidence/desktop-machines-parity/machines-sidebar-light.png) | [Dark](evidence/desktop-machines-parity/machines-sidebar-dark.png) |
| Normal remote session | [Light](evidence/desktop-machines-parity/machines-workspace-light.png) | [Dark](evidence/desktop-machines-parity/machines-workspace-dark.png) |
| Machines settings/routes | [Light](evidence/desktop-machines-parity/machines-settings-light.png) | [Dark](evidence/desktop-machines-parity/machines-settings-dark.png) |
| Your permissions | [Light](evidence/desktop-machines-parity/machines-permissions-light.png) | [Dark](evidence/desktop-machines-parity/machines-permissions-dark.png) |

The open menu is asserted painted in both themes; the normal header identifies
the host, fixture Changes has a deterministic sanitized diff, permissions are
scrolled into view, and captures report no overflow, mutations or console errors.

## Verification record

The integrated normal-client loopback and independent reviewer both passed the
same combined proof: actual Engines/stores and signed HTTP/WebSocket listeners,
MachinesService/RpcRegistry/preload bridge, normal SessionClient and
HistoryJournal/TranscriptStore. It delivered all 2,406 ordered initial events,
retained prefix/live turn across fallback and cooled move-back, dispatched one
B prompt with A untouched, used a distinct backup bearer, refused reverse
saved-key authorization, grouped authenticated catalogs once, selected the
less-loaded host with Auto, honored Manual only, and purged B's watched cache
after B-only revocation while A remained usable.

All ten focused identity tests passed; independent review additionally ran real
Node processes for fresh, legacy, missing and empty primary races, and verified
legacy ID/sealed-key byte/public-key continuity plus refusal to reset a missing
signing key. Independent stale-manifest, pending-route-removal and 2,100-row
reconnect reproductions passed.

Fresh [bounded security certification](machines-t3-security-final.md) found no
open actionable core finding at `8b2d0dcb`. The
[final delta review](machines-final-delta-security.md) confirmed unchanged
boundaries through `e97d3a7a`. A fresh
[first-run review](machines-onboarding-final-review.md) identified two setup
ordering/ownership defects; both were corrected and independently closed in
source through `da40bbef`. The corresponding integrated regressions passed.
These reviews distinguish source inspection, executed disposable proofs and
unverified hardware.

| Check | Result |
| --- | --- |
| All ten package typechecks | Passed; final desktop runtime/fixture typecheck also passed |
| Full repository lint | Passed after final corrections |
| Contracts | 224 passed |
| Remote gateway | 182 passed on full corrected rerun |
| Remote client | 24 passed |
| Engine | 801 passed in full run; both named failing cases passed on bounded rerun |
| Ari Core | 282 passed |
| Providers | 702 passed, one skipped |
| Shared | 16 passed |
| UI | 323 passed |
| Mobile | 371 passed |
| Desktop full suite | 3,740 passed, 26 failed, four skipped; all failing files covered by passing correction reruns |
| Desktop correction coverage | 219 owner tests passed; host/runtime 76/76; navigation/first-send/sidebar passed; final onboarding 13/13 including both new races |
| Desktop and mobile production builds | Both passed after final runtime correction |
| Normal-client signed loopback | Passed in author and independent reviewer executions |
| Normal desktop captures | 16 light/dark images and painted-menu assertions passed |

The long full-suite invocation overlapped reviewed fixture/runtime corrections;
this is a completion record with scoped reruns, not a claim of one clean full
invocation. Gateway's four failures were legacy extension-omission fixtures.
Engine's two loaded Windows timeout/late-cleanup cases passed with 60-second
test/hook bounds and unchanged runtime. Desktop's six failing files comprised
old scoped mock arity/IDs and capability assumptions, setup completion tests
transformed against cached pre-correction runtime, and a short socket-path
test run under the long private TEMP. A protected shorter D: TEMP passed that
unchanged test. Intermediate wrong sidebar/menu role expectations were corrected
without weakening host, scope or filesystem guards. The complete owner suites,
host/runtime files and App/normal sidebar deltas were then rerun. Original
failures, exact commands, resource admission and final outcomes remain in the
[UTF-8 verification artifacts](evidence/machines-parity-verification/verification.json).

Every heavy check uses the resource lease, below-normal priority and one test
worker. C: must have at least 5 GiB free, commit headroom at least 1.5 GiB; two
slots require at least 6 GiB headroom. The user approved temporarily pausing only
Ari Dev Machines to complete final checks. A protected private D: TEMP avoids
the known shared-temp ACL issue in provider prompt-file tests. Production output
is isolated from the live dev watcher's output. Original failures and corrected
reruns are retained rather than reported as initial passes.

## Handoff and remaining hardware

No push or PR was created. Standalone `fix/tailscale-serve-recovery` and
`fix/parallel-project-worktrees` remain separate; the latter remains at
`5010f950` (PR #517). The user's checkout, installed Ari, other UI dev profile
and real Tailscale Serve configuration were not changed. The Machines preview
uses its own identity/AppUserModelID/lock, D: profile and renderer 5197, gateway
8797 configured with hosting off, speech/Discord off. Preview readiness after
the approved verification pause is recorded in
[machines-dev-preview.md](machines-dev-preview.md). Its tray Quit stops it,
while window Close hides it. Do not use global Serve replacement or
machine-wide updater controls in it.

Worker results were reviewed before integration: **Verified machine routes**
supplied signed route supervision and removal fences; **Normal session parity**
supplied the scoped facade and replay/reconnect handling; **Unified composer
machines** supplied the draft selector, grouping, Auto and screenshots;
**Host parity validation** supplied narrow host operations and the combined
proof; **Machines security proof**, **Machines final source delta review** and
**First-run draft review** supplied independent dispositions; **Desktop fixture
parity** migrated navigation/onboarding fixtures. Their finished Machines
worktrees are cleaned after verification. The user's separate voice and
permission side sessions remain untouched.

The phone remains unchanged. A matching phone new-chat selector would reuse the
authenticated repository/catalog/permission extensions and shared transport,
add a touch picker and durable machine+project draft scope, delay first create
until Send, and retain host locks and uncertain receipts. It needs phone-specific
storage/offline/UI tests; no host cloning or implicit reverse approval is needed.

Confirm the conservative Auto thresholds, case/port correlation policy and
future ordering of headless hosting versus transactional remote updates. LAN
stays off; no decision is required to preserve the chosen Tailscale-only scope.

Still needs two actual desktops and an iPhone on the same tailnet: verified TLS
and DNS/TCP destinations, independent approvals both directions, sleep/wake,
network/ACL changes, non-443 PWA pairing/storage, OS secure-storage restart and
unavailable-keyring behavior, abrupt power loss, real PTY/provider descendant
cleanup, and private Connect registration/lease renewal/revocation. Headless
services, approval socket permissions, cross-runtime profile locks and updater
trial/rollback require their own runtime implementation and fresh review.
