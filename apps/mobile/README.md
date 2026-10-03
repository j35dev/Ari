# Ari Mobile

The phone side of Ari: an installable PWA that drives an Ari desktop while the
agents keep running there. It is a remote control, not a viewer — sessions can
be created, prompted, queued, steered and interrupted, approvals and questions
can be answered with the provider's own choices. The workspace includes rich
conversation, image references, file browsing, diffs, isolated task forks,
reviewed integration and an explicitly authorized desktop terminal.

It reaches the desktop one of two ways, and never needs the other:

- **Tailscale** (self-hosted, no account): the desktop wizard configures
  `tailscale serve` for the gateway, and the same build is served from that
  origin.
- **Ari Connect** (managed): the PWA is served from the Connect origin and
  calls a Cloudflare-tunnelled gateway. The Connect service is a separate,
  private repository and is not required by anything here.

## Running it

```sh
pnpm --filter @ari/mobile dev      # dev server on :5273
pnpm --filter @ari/mobile build    # static bundle in apps/mobile/dist
pnpm --filter @ari/mobile test     # the client against a real gateway
```

The bundle is static. Under Tailscale the gateway serves it from disk so the
app and API share an origin. Build with `VITE_ARI_CONNECT=true` for the hosted
layout: the Ari Connect Worker serves its assets and account APIs together.
The Connect repository's `pnpm build:mobile` script builds and copies this
bundle without deploying it.

## Mobile workflow

Sessions is the home screen, with search, running/pinned filters and recent
work. Projects groups sessions and offers creation with a draft, provider and
model. Inbox checks every authorized page for approvals, questions and
failures. Settings contains the computer, connection, appearance,
installation instructions and private-beta access controls for the owner.

Within a session, Chat keeps the composer reachable above a software
keyboard. Queue, Steer and Stop retain their different meanings. Tool output
and reasoning expand inline; approval details preserve the complete payload
and exact provider choices. Changes offers per-file diffs and integration
review, Files provides bounded text previews, and Terminal appears only if
the desktop explicitly granted shell access to this paired device.

Forking uses the native delegation policy and approval flow, inherits the
parent's permission ceiling, and creates an isolated worktree. Integration
shows the changed files and both snapshot identifiers, then rejects stale
snapshots or conflicts without overwriting unrelated parent work.

## How it authenticates

Nothing here holds a password. The phone generates a non-extractable ECDSA
P-256 key in Web Crypto and keeps it in IndexedDB; the desktop, on the user's
explicit approval, records the matching public key against a device id.

- The **device key** is the durable credential. It cannot be exported by
  script, so a same-origin compromise can use it while the page is open but
  cannot copy it to another machine.
- The **bearer token** is operational, short-lived, and never written down. It
  is minted on demand by signing a server-issued nonce, which is why a desktop
  restart costs a phone a signature rather than a new QR code.
- Pairing is finished by the _desktop_, never by the link: whoever photographs
  the QR code still has to be approved, by name and confirmation code, on the
  computer being reached.
- Under Ari Connect, WorkOS identifies the account; the broker admits only
  approved, verified-email invitations bound to an immutable identity.
  Desktop-approved devices additionally prove their keys to obtain signed,
  computer/device/project-bound leases lasting at most 120 seconds. A
  separate managed gateway requires both the lease and device authorization.
- Cloudflare supplies the outbound relay. Transport uses TLS; this build
  does not claim application-level end-to-end encryption through the relay.

## Data on the device

| Kept                                                                              | Not kept                                            |
| --------------------------------------------------------------------------------- | --------------------------------------------------- |
| Device key (IndexedDB, non-exportable)                                            | Bearer tokens (memory only)                         |
| Device id and name                                                                | Transcripts, diffs, tool output                     |
| The desktop's address                                                             | Provider keys, filesystem contents                  |
| Drafts and uncertain command receipts (sessionStorage, scoped by computer/device) | Attachment bytes or terminal input                  |
| Shell identifiers and local project stars                                         | Account or managed-access tokens in browser storage |

Restored drafts and receipts are never sent automatically. Retrying an
uncertain prompt, creation, fork or integration uses its original receipt.
The service worker caches only public shell assets and bypasses account and
gateway APIs. New versions wait for an explicit update action.

Clearing site data loses the key, and the only recovery is pairing again —
deliberately not a silent weakening of anything. "Forget this computer" in
Settings does the same thing on purpose.

## Installing it

Android/Chrome: open the address and choose _Install app_ from the menu, or
accept the prompt when it appears. iPhone/Safari: _Share → Add to Home
Screen_. Browser use is fully supported without installing; the installed app
adds a standalone window and an icon.

## Desktop setup and boundaries

On the computer, open Settings → Mobile access. Choose your own Tailscale
connection or configure the Ari Connect broker and sign in. Review the
phone's confirmation code, select its projects, and optionally grant terminal
access. A terminal runs as the desktop user and is not a project sandbox.
Removing the phone or disabling Mobile access closes its remote access.

Provider installation, provider credentials, permission ceilings and new
filesystem roots stay in desktop settings. Files are previews rather than a
mobile editor. Push notifications and waking a sleeping computer are outside
this build. Connect requires a configured HTTPS origin, Cloudflare resources,
WorkOS identity/webhook configuration and backend secrets before deployment.

## Validation

`pnpm verify` covers the monorepo's typecheck, lint and tests. Mobile tests
exercise real gateway pairing/authorization and command reconciliation, plus
component recovery, Markdown sanitization, shell references and service-worker
cache behavior. Browser layout checks cover 360/390-pixel widths, dark/light
appearance, reduced viewport height, offline drafts and lost responses.
Physical iPhone keyboard/safe-area behavior and live hosted identity/tunnel
operation remain release checks; fixtures do not substitute for those.
