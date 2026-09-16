# Changelog

## 0.4.0 — 2026-09-16

- Added `asset: 'sn80'` to the bridge builders and preparation methods for Base
  SN80 ↔ Finney subnet-80 stake. Existing calls continue to default to TAO.
- Added the verified Base and Finney SN80 token addresses and `SN80_NETUID`.
- SN80 staking approvals use netuid 80 and alpha RAO; ERC-20 approvals use the
  Base SN80 token. The partner fee remains 0% and the full principal crosses.
- Rejects unsupported SN80 liquid TAO conversion, other subnets, and other
  EVM lanes before requesting a quote.
- Added an optional `partnerFee: { recipient, bps }` to every bridge builder and
  `prepare*` method. The fee is charged on top of the bridged amount via the V5
  `*WithFee` entrypoints and paid to the recipient on the source chain; the full
  amount still crosses. `prepare*` enforces the gateway's `maxIntegratorFeeBps`.
  Added `partnerFeeWei` to `BridgePreparation`, `MAX_PARTNER_FEE_BPS`,
  `partnerFeeCut`, `partnerFeeTaoTopUp`, and the `INVALID_PARTNER_FEE` error
  code. Omitting the fee keeps the zero-fee calls and byte-identical plans.
  The hub quote uses the deployed `quoteBridgeOutWithFee(…, taoAmount,
stakedAlphaRao, fee)` signature and cross-checks its top-ups against the SDK.
- SN80 plans keep `minTaoOut` equal to the bridged amount, like TAO.
- Updated deployment metadata version to 1.2.0.

## 0.3.0 — 2026-09-16

- Moved bridging to the V5 gateways. `contracts.gateway` is now
  `0x1da2415229b614C787e145D1D7346eb496319C52` on Base,
  `0xf27fdA637131E25B2A1b4865ED9597d881980c7E` on Robinhood, and
  `0xcd0C6d98D0A126B1c113d15b4c28F38321437787` on Subtensor. Existing approvals
  for the old gateways do not carry over.
- Added `contracts.legacyGateway` with the previous gateway addresses. Receipt
  parsing and CCIP delivery tracking accept both, so bridges sent through the old
  gateways can still be tracked.
- Added the V5 `*WithFee` bridge entrypoints, `maxIntegratorFeeBps`,
  `bridgeFeeBps`, `integratorTaoTopUp`, and the `NotDelivered` event to the ABIs.
  Plans still use the zero-fee entrypoints; the partner fee is 0%.
- Fixed the `claimableToken` ABI argument names to `(token, account)`, the
  order the gateway has always used. The selector is unchanged.
- `getCcipDeliveryStatus` reports `recovery` when the Subtensor gateway emits
  `NotDelivered`, not only `Claimable`.
- Added `MIN_LIQUID_SUBTENSOR_TO_EVM_WEI`: bridging liquid TAO from Subtensor
  requires at least 0.002 TAO.
- Plan regression fixtures now check the V5 plans, which differ from the
  originals only in the gateway address.

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
