# Changelog

## 0.5.9

- Add Base-only Ditto SN118 and Affine SN120 token metadata and staked bridge plans.
- Reject Robinhood routes and wrong-netuid approvals for both assets.
- Deployment metadata version 1.7.0; public token launch remains separately controlled.

## 0.5.8

- Restrict SN78 to Base; expose a null Robinhood token and reject unsupported bridge plans in both directions. Base and Subtensor SN78 addresses and other assets remain unchanged.
- Deployment metadata version 1.6.1.

## 0.5.7

- Add Umi SN78 on Base, Robinhood and Subtensor, with staked-only subnet 78 approvals and bridge plans.
- Extend live integration coverage to SN10 and SN78.

## 0.5.6 — 2026-09-22

- Add Pareton (SN10) deployment metadata on Base, Robinhood and Subtensor.
- Support staked-only SN10 bridge plans and preparation in both directions
  on both EVM spokes, enforcing netuid 10. Deployment version is 1.5.0.

## 0.5.5 — 2026-09-21

- Discover destination off-ramps from the canonical CCIP router for the source
  chain, retaining the configured legacy off-ramp for historical transfers.
  Cache discovery for five minutes per provider and coalesce concurrent reads.
- Recognise both legacy and CCIP v2 execution events and select the latest
  execution across off-ramps. This fixes completed Finney-to-Robinhood SN80
  deliveries remaining in the waiting state. Verified against a real delivery.

## 0.5.4 — 2026-09-21

- Added the canonical Robinhood SN80 token to deployment metadata and enabled
  staked SN80 bridge preparation between Robinhood and Finney in both
  directions. Deployment metadata version is 1.4.0.

## 0.5.3 — 2026-09-19

- Increased EVM-to-Subtensor CCIP destination execution gas from the spoke
  gateways' 300,000 default to an explicit 3,500,000. A 900,000 manual
  execution reached the gateway but still fell back to a claimable booking;
  the same live liquid claim path estimates near 2,560,000 gas. Quotes and
  transaction calldata now use the same exported
  `EVM_TO_SUBTENSOR_DESTINATION_GAS_LIMIT` for zero-fee and partner-fee
  bridges. Callers can override it per transaction with the optional
  `destinationGasLimit` request field, without changing or republishing the
  SDK.
- Added the explicit-gas `quoteBridgeToFinney` and `bridgeToFinney` overloads
  to the public SpokeGateway ABI.

## 0.5.2 — 2026-09-16

- Added opt-in stake rounding adjustment to Subtensor bridge preparation, with an explicit disable option and adjusted amount/plan metadata. Searches only on `StrandedStake`, preserves minimum output, requotes candidates and checks source balances, minimum remainders and partner-fee allocations. Approval-required plans are explicitly marked as not yet simulated.
- Exported the same provider-neutral search (`estimateRoundedStake`), nested revert decoder and dust minimum helper so integrations do not need their own rounding implementation.

## 0.5.1 — 2026-09-16

- Added optional `minAmountOutWei` to Subtensor-to-EVM bridge requests. Callers can explicitly bound output slippage, including staking rounding dust. Defaults to the input amount; rejects zero, negative, non-bigint, and above-input minima before RPC calls. The same minimum is used for gas estimation and final calldata, for single- and multi-validator routes with or without partner fees.

## 0.5.0 — 2026-09-16

- Staked bridges from Subtensor can pull from several validators. Pass
  `stakePulls: [{ hotkey, amountRao }]` (1–16 entries, unique hotkeys, summing
  to the bridged amount) and the plan calls the V5.1 gateway's
  `bridgeOutFromValidators` (or `…WithFee`), which re-delegates every pull to
  the token's canonical validator before depositing. Without `stakePulls` the
  plan keeps the single-validator `bridgeOut` call. With a partner fee the cut
  is charged on top and spread across the pulls in proportion to their
  amounts, so each position needs headroom for its share. Added `StakePull`, `MAX_STAKE_PULLS`, and the
  `bridgeOutFromValidators*`, `minStakeRequired`, `MAX_STAKE_SOURCES` and
  `GATEWAY_COLDKEY` ABI entries.
- Moved the Subtensor gateway to the V5.1 deployment at
  `0xd5Fa238aa4177f6c1341491969d9cBeec94EEd69`. `contracts.legacyGateway` is
  now `contracts.legacyGateways`, a list of retired hubs (oldest first) used for
  receipt and delivery tracking; the V5 hub stays listed because the spoke
  gateways still deliver through it. Deployment metadata version is 1.3.0.

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
