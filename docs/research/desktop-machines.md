# Desktop Machines implementation

Workstream D, branch `machines/desktop-ui`. Frozen design: `docs/design/machines.md`
in the coordinator checkout. Desktop renderer only; host/core/shared contracts
and the Mobile access page belong to other workers.

The implementation uses a dedicated remote workspace. Machine IDs accompany all
queries, mutations, stream parameters, drafts, staged images, and uncertain
receipts. Remote paths never reach desktop filesystem or command dispatch RPCs.
Terminal visibility requires the authenticated `MachineView.allowTerminal` grant.

Verification will use focused desktop suites, the shared atomic heavy runner,
and deterministic temporary browser fixtures. No saved settings, paired devices,
running Ari, Tailscale configuration, pushes, or PRs are changed.

Baseline and final results are recorded below when available.
