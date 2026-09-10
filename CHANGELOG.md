# Changelog

## 0.2.0 — 2026-09-10

- Replaced ethers with viem 2.56.3 for RPC clients, ABI encoding, gas estimation,
  event decoding, and transaction tracking.
- Replaced `@polkadot/util` and `@polkadot/util-crypto` with PAPI's
  `@polkadot-api/substrate-bindings` 0.21.1 for SS58 validation and mirror addresses.
- Added `toViemTransaction()` and a typed example that reuses existing viem clients.
  Retained the dependency-free `toEthersTransaction()` compatibility adapter.
- Lower-level tracking functions accept viem public clients and retain support
  for ethers-style JSON-RPC providers through a dependency-free adapter. The
  high-level transport interface, human-readable ABIs, and plan format are unchanged.
- Enforced the plan's canonical chain in `toViemTransaction()` and rejected
  unsupported chain IDs before signing.
- Preserved uppercase EVM address normalization and mixed-case checksum validation.
- Added regression tests for wrong-chain signing, legacy provider tracking, and
  address normalization.
- Added original-implementation plan and address regression fixtures; migrated
  offline tests, fork tests, and the guarded live canary to the new libraries.
- Fixed the Base canary to request staked delivery: its 0.001 TAO maximum is below
  the 0.01 TAO liquid-delivery minimum. Broadcast guards and funding caps remain.

## 0.1.0

- Added canonical Base and Subtensor production deployment metadata.
- Added the canonical Robinhood deployment, bridge plans, receipt parsing, and
  CCIP delivery tracking.
- Added unsigned, approval-aware bridge plans in both directions.
- Enforced the 1:1 bridge invariant by encoding the bridged principal as the
  minimum destination output while charging network fees separately.
- Rejected liquid Base-to-Subtensor deliveries below the `0.01 TAO` Subtensor
  unstaking minimum.
- Added vault create, deposit, withdrawal, fee-claim, stake, and unstake plans.
- Added EIP-1193 and ethers transaction adapters plus canonical receipt parsers.
- Added destination-chain checkpoints and CCIP delivery status tracking with
  Base-to-Subtensor recovery detection.
- Restricted delivery events to the current lane's authorized CCIP off-ramps.
- Added source transaction confirmation and canonical message-ID lookup.
- Added strict bigint, uint256, EVM address, Bittensor SS58, bytes32, whole-RAO,
  source/delivery, and boolean validation.
- Added offline unit/property/protocol tests, production-fork checks, package
  verification, and a guarded real-key canary workflow.
- Added pinned CI, production-fork, and npm trusted-publishing workflows.
- Rejected plaintext remote RPC endpoints and malformed transport requests.
- Raised the supported Node.js baseline to the maintained Node.js 22 line.
