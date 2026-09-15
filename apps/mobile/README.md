# Ari Mobile

The phone side of Ari: an installable PWA that drives an Ari desktop while the
agents keep running there. It is a remote control, not a viewer — sessions can
be created, prompted, queued, steered and interrupted, approvals and questions
can be answered with the provider's own choices, and changes can be read.

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

The bundle is static: there is no server to deploy. In the managed layout it
is uploaded to static hosting; under Tailscale the gateway serves it from disk
so that the app and the API share an origin.

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
- Pairing is finished by the *desktop*, never by the link: whoever photographs
  the QR code still has to be approved, by name and confirmation code, on the
  computer being reached.

## Data on the device

| Kept | Not kept |
| --- | --- |
| Device key (IndexedDB, non-exportable) | Bearer tokens (memory only) |
| Device id and name | Transcripts, diffs, tool output |
| The desktop's address | Provider keys, filesystem contents |

Clearing site data loses the key, and the only recovery is pairing again —
deliberately not a silent weakening of anything. "Forget this computer" in
Settings does the same thing on purpose.

## Installing it

Android/Chrome: open the address and choose *Install app* from the menu, or
accept the prompt when it appears. iPhone/Safari: *Share → Add to Home
Screen*. Browser use is fully supported without installing; the installed app
adds a standalone window and an icon.

## What this build does not do

Deferred by design (ADR §3), not missing by accident: a code editor, a shell,
registering new filesystem roots, provider login or API keys, push
notifications, and controlling a machine that is asleep. Changes are read-only
here: the desktop does not yet expose a per-file change list, so the Changes
tab says so instead of guessing.
