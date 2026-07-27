# Security policy

Report suspected vulnerabilities privately to Axiom Games' designated security contact. Do not include seeds, credentials, player/operator data, or exploit details in public issues. There is currently no public disclosure channel or bounty program.

Security-sensitive invariants are defined in `docs/threat-model.md`: one deterministic truth per seed/context, canonical proof/config binding, bounded hostile inputs, frame-fenced proof settlement, command-bound idempotency, exact accounting, original cap basis, and side-effect-free failure. Production authentication, wallets, databases, key custody, and regulatory controls remain outside this library.
