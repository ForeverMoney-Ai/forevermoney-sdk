import { encodeFunctionData, parseAbi, type PublicClient } from 'viem'
import {
    ALPHA_GATEWAY_ABI,
    ERC20_ABI,
    SPOKE_GATEWAY_ABI,
    STAKING_ABI,
} from '../abis/index.js'
import {
    normalizeEvmAddress,
    normalizeSS58,
    ss58ToPublicKey,
} from '../core/addresses.js'
import {
    assertWholeRao,
    feeWithBuffer,
    gasLimitWithBuffer,
} from '../core/amounts.js'
import {
    EVM_WEI_PER_RAO,
    SN80_NETUID,
    foreverMoneyDeployment,
    getForeverMoneyEvmDeployment,
    type ForeverMoneyEvmChain,
} from '../chains/deployment.js'
import { ForeverMoneyError } from '../core/errors.js'
import {
    createTransactionPlan,
    type TransactionPlan,
    type TransactionStep,
} from '../core/plans.js'
import {
    assertNonNegativeAmount,
    normalizeBytes32,
} from '../core/validation.js'
const erc20Abi = parseAbi(ERC20_ABI)
const spokeAbi = parseAbi(SPOKE_GATEWAY_ABI)
const alphaAbi = parseAbi(ALPHA_GATEWAY_ABI)
const stakingAbi = parseAbi(STAKING_ABI)
export const MIN_LIQUID_EVM_TO_SUBTENSOR_WEI = 10000000000000000n
export const MIN_LIQUID_BASE_TO_SUBTENSOR_WEI = MIN_LIQUID_EVM_TO_SUBTENSOR_WEI
// Subtensor's minimum new stake is 2,000,000 RAO (0.002 TAO).
export const MIN_LIQUID_SUBTENSOR_TO_EVM_WEI = 2_000_000n * EVM_WEI_PER_RAO
export type SubtensorDelivery = 'liquid' | 'staked'
export type SubtensorSource = 'liquid' | 'staked'
export type BridgeAsset = 'tao' | 'sn80'
/**
 * Optional partner (integrator) fee, charged ON TOP of the bridged amount and
 * paid to `recipient` on the source chain. The full `amountWei` still crosses.
 * `bps` is in basis points (1 = 0.01%); the gateway caps it at
 * `maxIntegratorFeeBps`, which `prepare*` reads and enforces.
 */
export interface PartnerFee {
    readonly recipient: string
    readonly bps: number
}
export const MAX_PARTNER_FEE_BPS = 10_000
/**
 * One staked position to pull from when bridging staked alpha from Subtensor:
 * the validator hotkey the caller's stake sits on and how much of it to take.
 * The gateway re-delegates every pull to the token's canonical validator
 * before depositing, so stake with any validator can be bridged.
 */
export interface StakePull {
    readonly hotkey: string
    readonly amountRao: bigint
}
/** Gateway limit on positions per bridge (`AlphaGateway.MAX_STAKE_SOURCES`). */
export const MAX_STAKE_PULLS = 16
export interface EvmToSubtensorRequest {
    readonly evmChain: ForeverMoneyEvmChain
    readonly asset?: BridgeAsset
    readonly partnerFee?: PartnerFee
    readonly sender: string
    readonly amountWei: bigint
    readonly destination: string
    readonly delivery: SubtensorDelivery
}
export interface SubtensorToEvmRequest {
    readonly evmChain: ForeverMoneyEvmChain
    readonly asset?: BridgeAsset
    readonly partnerFee?: PartnerFee
    readonly sender: string
    readonly recipient: string
    readonly amountWei: bigint
    readonly source: SubtensorSource
    readonly netuid?: bigint
    /**
     * For a staked source: the positions to pull, summing to `amountWei` in
     * RAO. Omit when the stake already sits on the token's canonical validator.
     * With a partner fee, the cut is pulled from `stakePulls[0]` on top, so that
     * position must hold `amountRao + cut`.
     */
    readonly stakePulls?: readonly StakePull[]
}
export type BaseToSubtensorRequest = Omit<EvmToSubtensorRequest, 'evmChain'>
export type SubtensorToBaseRequest = Omit<SubtensorToEvmRequest, 'evmChain'>
export interface BridgePreparation {
    readonly exactNetworkFeeWei: bigint
    readonly transactionValueWei: bigint
    /**
     * Extra the sender pays for the partner fee, in the units of the source leg:
     * token wei for an EVM source, alpha (as 18-decimal wei) for a staked source,
     * TAO wei for a liquid source. Zero when no partner fee is set.
     */
    readonly partnerFeeWei: bigint
    readonly plan: TransactionPlan
}
interface ResolvedPartnerFee {
    readonly recipient: `0x${string}`
    readonly bps: number
}
const NO_PARTNER_FEE: ResolvedPartnerFee = {
    recipient: '0x0000000000000000000000000000000000000000',
    bps: 0,
}
function resolvePartnerFee(
    fee: PartnerFee | undefined,
    gateway: `0x${string}`
): ResolvedPartnerFee {
    if (fee === undefined) return NO_PARTNER_FEE
    if (
        typeof fee.bps !== 'number' ||
        !Number.isInteger(fee.bps) ||
        fee.bps < 0 ||
        fee.bps > MAX_PARTNER_FEE_BPS
    ) {
        throw new ForeverMoneyError(
            'INVALID_PARTNER_FEE',
            `Partner fee bps must be an integer between 0 and ${MAX_PARTNER_FEE_BPS}.`,
            { bps: fee.bps }
        )
    }
    if (fee.bps === 0) return NO_PARTNER_FEE
    const recipient = normalizeEvmAddress(fee.recipient)
    if (
        recipient === NO_PARTNER_FEE.recipient ||
        recipient.toLowerCase() === gateway.toLowerCase()
    ) {
        throw new ForeverMoneyError(
            'INVALID_PARTNER_FEE',
            'Partner fee recipient must not be the zero address or the gateway.',
            { recipient }
        )
    }
    return { recipient, bps: fee.bps }
}
/** `bps` of `amount`, rounded down: the extra token (spoke) or alpha (hub) pulled on top. */
export function partnerFeeCut(amount: bigint, bps: number): bigint {
    return (amount * BigInt(bps)) / 10_000n
}
/** Extra native TAO a liquid Subtensor source carries for the partner, rounded up to a whole RAO. */
export function partnerFeeTaoTopUp(taoAmount: bigint, bps: number): bigint {
    const raw = partnerFeeCut(taoAmount, bps)
    if (raw === 0n) return 0n
    return ((raw + EVM_WEI_PER_RAO - 1n) / EVM_WEI_PER_RAO) * EVM_WEI_PER_RAO
}
function assertPartnerFeeAllowed(fee: ResolvedPartnerFee, maxBps: number) {
    if (fee.bps > maxBps) {
        throw new ForeverMoneyError(
            'INVALID_PARTNER_FEE',
            `Partner fee of ${fee.bps} bps exceeds the gateway maximum of ${maxBps} bps.`,
            { bps: fee.bps, maxBps }
        )
    }
}
function bridgeAsset(
    evmChain: ForeverMoneyEvmChain,
    asset: BridgeAsset = 'tao'
) {
    if (asset !== 'tao' && asset !== 'sn80') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Asset must be "tao" or "sn80".'
        )
    }
    if (asset === 'sn80' && evmChain !== 'base') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'SN80 bridging is supported between Base and Subtensor.'
        )
    }
    const evm = getForeverMoneyEvmDeployment(evmChain)
    return asset === 'sn80'
        ? {
              evmToken: foreverMoneyDeployment.base.contracts.wrappedSn80,
              subtensorToken:
                  foreverMoneyDeployment.subtensor.contracts.wrappedSn80,
              label: 'SN80',
              wrappedLabel: 'SN80',
          }
        : {
              evmToken: evm.contracts.wrappedTao,
              subtensorToken:
                  foreverMoneyDeployment.subtensor.contracts.wrappedTao,
              label: 'TAO',
              wrappedLabel: 'wrapped TAO',
          }
}
function assertAssetMode(
    asset: BridgeAsset | undefined,
    mode: SubtensorSource
): void {
    if (asset === 'sn80' && mode !== 'staked') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'SN80 bridging requires staked subnet 80 input or delivery; liquid TAO conversion is not supported.'
        )
    }
}
function sourceNetuid(input: SubtensorToEvmRequest): bigint | undefined {
    if (input.source !== 'staked') return undefined
    const netuid =
        input.netuid ?? (input.asset === 'sn80' ? SN80_NETUID : undefined)
    if (netuid === undefined) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'A netuid is required when bridging staked TAO.'
        )
    }
    assertNonNegativeAmount(netuid, 'netuid')
    if (input.asset === 'sn80' && netuid !== SN80_NETUID) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'SN80 staking approvals must use netuid 80.'
        )
    }
    return netuid
}
/** Resolved pulls for a staked source that names them; undefined otherwise. */
function stakePullsFor(
    input: SubtensorToEvmRequest,
    amountRao: bigint
): ResolvedStakePull[] | undefined {
    if (input.stakePulls === undefined) return undefined
    if (input.source !== 'staked') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Stake pulls are only valid for a staked source.'
        )
    }
    return resolveStakePulls(input.stakePulls, amountRao)
}
function assertDelivery(value: unknown): asserts value is SubtensorDelivery {
    if (value !== 'liquid' && value !== 'staked') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Delivery must be "liquid" or "staked".'
        )
    }
}
function assertSource(value: unknown): asserts value is SubtensorSource {
    if (value !== 'liquid' && value !== 'staked') {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Source must be "liquid" or "staked".'
        )
    }
}
function assertBaseToSubtensorAmount(
    amountWei: bigint,
    delivery: SubtensorDelivery
): void {
    assertWholeRao(amountWei)
    if (delivery === 'liquid' && amountWei < MIN_LIQUID_EVM_TO_SUBTENSOR_WEI) {
        throw new ForeverMoneyError(
            'AMOUNT_BELOW_MINIMUM',
            'Liquid delivery from an EVM chain to Subtensor requires at least 0.01 TAO.',
            {
                amountWei: amountWei.toString(),
                minimumAmountWei: MIN_LIQUID_EVM_TO_SUBTENSOR_WEI.toString(),
            }
        )
    }
}
function assertSubtensorToEvmAmount(
    amountWei: bigint,
    source: SubtensorSource
): void {
    assertWholeRao(amountWei)
    if (source === 'liquid' && amountWei < MIN_LIQUID_SUBTENSOR_TO_EVM_WEI) {
        throw new ForeverMoneyError(
            'AMOUNT_BELOW_MINIMUM',
            'Bridging liquid TAO from Subtensor requires at least 0.002 TAO.',
            {
                amountWei: amountWei.toString(),
                minimumAmountWei: MIN_LIQUID_SUBTENSOR_TO_EVM_WEI.toString(),
            }
        )
    }
}
export interface BuildEvmToSubtensorPlanRequest extends EvmToSubtensorRequest {
    readonly allowanceWei: bigint
    readonly exactNetworkFeeWei: bigint
    readonly estimatedBridgeGas?: bigint
}
export interface BuildSubtensorToEvmPlanRequest extends SubtensorToEvmRequest {
    readonly stakingAllowanceRao?: bigint
    readonly exactNetworkFeeWei: bigint
    readonly estimatedBridgeGas?: bigint
}
export type BuildBaseToSubtensorPlanRequest = Omit<
    BuildEvmToSubtensorPlanRequest,
    'evmChain'
>
export type BuildSubtensorToBasePlanRequest = Omit<
    BuildSubtensorToEvmPlanRequest,
    'evmChain'
>
function transactionStep(
    kind: TransactionStep['kind'],
    label: string,
    chainId: number,
    from: string,
    to: string,
    data: string,
    value: bigint,
    gasLimit?: bigint
): TransactionStep {
    return {
        kind,
        label,
        transaction: {
            chainId,
            from,
            to,
            data,
            value: value.toString(),
            ...(gasLimit === undefined
                ? {}
                : { gasLimit: gasLimit.toString() }),
        },
    }
}
type ExitParams = {
    ss58: `0x${string}`
    evmFallback: `0x${string}`
    wantLiquid: boolean
    minTaoOut: bigint
}
function partnerFeeSummary(
    charged: bigint,
    unit: string,
    fee: ResolvedPartnerFee
): string {
    if (fee.bps === 0) return ''
    return ` Partner fee: ${charged} wei of ${unit} (${fee.bps} bps) on top, paid to ${fee.recipient}.`
}
/** Zero-fee calls keep the original entrypoints so existing plans stay byte-identical. */
function encodeSpokeBridge(
    token: `0x${string}`,
    amountWei: bigint,
    exit: ExitParams,
    fee: ResolvedPartnerFee
): `0x${string}` {
    return fee.bps === 0
        ? encodeFunctionData({
              abi: spokeAbi,
              functionName: 'bridgeToFinney',
              args: [token, amountWei, exit],
          })
        : encodeFunctionData({
              abi: spokeAbi,
              functionName: 'bridgeToFinneyWithFee',
              args: [token, amountWei, exit, 0n, fee],
          })
}
type ResolvedStakePull = { validator: `0x${string}`; alphaRao: bigint }
/**
 * Validate the caller's pull list against the gateway's rules: 1..16 entries,
 * unique bytes32 hotkeys, positive amounts, summing to the bridged alpha.
 */
function resolveStakePulls(
    pulls: readonly StakePull[],
    amountRao: bigint
): ResolvedStakePull[] {
    if (pulls.length === 0 || pulls.length > MAX_STAKE_PULLS) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            `Between 1 and ${MAX_STAKE_PULLS} stake pulls are required.`,
            { count: pulls.length }
        )
    }
    const seen = new Set<string>()
    let total = 0n
    const resolved = pulls.map((pull) => {
        const validator = normalizeBytes32(pull.hotkey, 'Stake pull hotkey')
        if (validator === `0x${'0'.repeat(64)}`) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                'Stake pull hotkey must not be zero.'
            )
        }
        const key = validator.toLowerCase()
        if (seen.has(key)) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                'Stake pulls must not repeat a hotkey.',
                { hotkey: validator }
            )
        }
        seen.add(key)
        if (typeof pull.amountRao !== 'bigint' || pull.amountRao <= 0n) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                'Each stake pull must take a positive amount of RAO.',
                { hotkey: validator }
            )
        }
        total += pull.amountRao
        return { validator, alphaRao: pull.amountRao }
    })
    if (total !== amountRao) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Stake pulls must sum to the bridged amount.',
            { pulledRao: total.toString(), amountRao: amountRao.toString() }
        )
    }
    return resolved
}
function encodeHubBridge(
    destSelector: bigint,
    token: `0x${string}`,
    recipient: `0x${string}`,
    taoAmount: bigint,
    stakedAlphaRao: bigint,
    minTokenOut: bigint,
    fee: ResolvedPartnerFee,
    pulls?: ResolvedStakePull[]
): `0x${string}` {
    if (pulls !== undefined) {
        const args = [
            destSelector,
            token,
            recipient,
            taoAmount,
            pulls,
            minTokenOut,
        ] as const
        return fee.bps === 0
            ? encodeFunctionData({
                  abi: alphaAbi,
                  functionName: 'bridgeOutFromValidators',
                  args,
              })
            : encodeFunctionData({
                  abi: alphaAbi,
                  functionName: 'bridgeOutFromValidatorsWithFee',
                  args: [...args, fee],
              })
    }
    const args = [
        destSelector,
        token,
        recipient,
        taoAmount,
        stakedAlphaRao,
        minTokenOut,
    ] as const
    return fee.bps === 0
        ? encodeFunctionData({
              abi: alphaAbi,
              functionName: 'bridgeOut',
              args,
          })
        : encodeFunctionData({
              abi: alphaAbi,
              functionName: 'bridgeOutWithFee',
              args: [...args, fee],
          })
}
async function quoteSpokeWithFee(
    provider: PublicClient,
    gateway: `0x${string}`,
    token: `0x${string}`,
    amountWei: bigint,
    exit: ExitParams,
    fee: ResolvedPartnerFee
): Promise<bigint> {
    const maxBps = await provider.readContract({
        address: gateway,
        abi: spokeAbi,
        functionName: 'maxIntegratorFeeBps',
    })
    assertPartnerFeeAllowed(fee, maxBps)
    const [networkFee] = await provider.readContract({
        address: gateway,
        abi: spokeAbi,
        functionName: 'quoteBridgeToFinneyWithFee',
        args: [token, amountWei, exit, 0n, fee],
    })
    return networkFee
}
async function quoteHubWithFee(
    provider: PublicClient,
    gateway: `0x${string}`,
    destSelector: bigint,
    token: `0x${string}`,
    recipient: `0x${string}`,
    mintedAmount: bigint,
    taoAmount: bigint,
    stakedAlphaRao: bigint,
    fee: ResolvedPartnerFee
): Promise<{
    networkFee: bigint
    taoTopUp: bigint
    alphaTopUpRao: bigint
}> {
    const maxBps = await provider.readContract({
        address: gateway,
        abi: alphaAbi,
        functionName: 'maxIntegratorFeeBps',
    })
    assertPartnerFeeAllowed(fee, maxBps)
    const [networkFee, taoTopUp, alphaTopUpRao, crossing] =
        await provider.readContract({
            address: gateway,
            abi: alphaAbi,
            functionName: 'quoteBridgeOutWithFee',
            args: [
                destSelector,
                token,
                recipient,
                mintedAmount,
                taoAmount,
                stakedAlphaRao,
                fee,
            ],
        })
    // The gateway computes the same top-ups the plan builder does; a mismatch
    // means the deployed contract differs from the ABI the SDK was built for.
    if (
        crossing !== mintedAmount ||
        taoTopUp !== partnerFeeTaoTopUp(taoAmount, fee.bps) ||
        alphaTopUpRao !== partnerFeeCut(stakedAlphaRao, fee.bps)
    ) {
        throw new ForeverMoneyError(
            'INVALID_PROVIDER_RESPONSE',
            'The gateway partner fee quote does not match the SDK fee calculation.',
            {
                crossing: crossing.toString(),
                taoTopUp: taoTopUp.toString(),
                alphaTopUpRao: alphaTopUpRao.toString(),
            }
        )
    }
    return { networkFee, taoTopUp, alphaTopUpRao }
}
export function buildEvmToSubtensorPlan(
    input: BuildEvmToSubtensorPlanRequest
): TransactionPlan {
    const sender = normalizeEvmAddress(input.sender)
    const asset = bridgeAsset(input.evmChain, input.asset)
    assertDelivery(input.delivery)
    assertAssetMode(input.asset, input.delivery)
    assertBaseToSubtensorAmount(input.amountWei, input.delivery)
    assertNonNegativeAmount(input.allowanceWei, 'Token allowance')
    assertNonNegativeAmount(input.exactNetworkFeeWei, 'Network fee')
    const destination = normalizeSS58(input.destination)
    const exit = {
        ss58: ss58ToPublicKey(destination),
        evmFallback: sender,
        wantLiquid: input.delivery === 'liquid',
        minTaoOut: input.amountWei,
    }
    const evm = getForeverMoneyEvmDeployment(input.evmChain)
    const partnerFee = resolvePartnerFee(
        input.partnerFee,
        evm.contracts.gateway
    )
    const cut = partnerFeeCut(input.amountWei, partnerFee.bps)
    const steps: TransactionStep[] = []
    if (input.allowanceWei < input.amountWei + cut) {
        steps.push(
            transactionStep(
                'approval',
                `Approve ${asset.wrappedLabel} for the ForeverMoney gateway`,
                evm.chainId,
                sender,
                asset.evmToken,
                encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'approve',
                    args: [evm.contracts.gateway, input.amountWei + cut],
                }),
                0n
            )
        )
    }
    const value = feeWithBuffer(input.exactNetworkFeeWei)
    steps.push(
        transactionStep(
            'transaction',
            `Bridge ${asset.wrappedLabel} from ${evm.name} to Subtensor (${input.delivery})`,
            evm.chainId,
            sender,
            evm.contracts.gateway,
            encodeSpokeBridge(
                asset.evmToken,
                input.amountWei,
                exit,
                partnerFee
            ),
            value,
            input.estimatedBridgeGas === undefined
                ? undefined
                : gasLimitWithBuffer(input.estimatedBridgeGas)
        )
    )
    return createTransactionPlan({
        action:
            evm.key === 'base'
                ? 'bridge.base-to-subtensor'
                : 'bridge.robinhood-to-subtensor',
        summary: `Bridge ${input.amountWei} wei of ${asset.wrappedLabel} from ${evm.name} to ${destination}.${partnerFeeSummary(cut, asset.wrappedLabel, partnerFee)}`,
        steps,
    })
}
export function buildBaseToSubtensorPlan(
    input: BuildBaseToSubtensorPlanRequest
): TransactionPlan {
    return buildEvmToSubtensorPlan({ ...input, evmChain: 'base' })
}
export function buildSubtensorToEvmPlan(
    input: BuildSubtensorToEvmPlanRequest
): TransactionPlan {
    const sender = normalizeEvmAddress(input.sender)
    const recipient = normalizeEvmAddress(input.recipient)
    const asset = bridgeAsset(input.evmChain, input.asset)
    assertSource(input.source)
    assertAssetMode(input.asset, input.source)
    const netuid = sourceNetuid(input)
    assertSubtensorToEvmAmount(input.amountWei, input.source)
    assertNonNegativeAmount(input.exactNetworkFeeWei, 'Network fee')
    const { subtensor } = foreverMoneyDeployment
    const evm = getForeverMoneyEvmDeployment(input.evmChain)
    const partnerFee = resolvePartnerFee(
        input.partnerFee,
        subtensor.contracts.gateway
    )
    const amountRao = input.amountWei / EVM_WEI_PER_RAO
    // Charged on top: extra alpha for a staked source, extra TAO for a liquid one.
    const alphaTopUpRao =
        input.source === 'staked'
            ? partnerFeeCut(amountRao, partnerFee.bps)
            : 0n
    const taoTopUp =
        input.source === 'liquid'
            ? partnerFeeTaoTopUp(input.amountWei, partnerFee.bps)
            : 0n
    const steps: TransactionStep[] = []
    if (input.source === 'staked') {
        if (input.stakingAllowanceRao === undefined) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                'The staking allowance is required when bridging staked TAO.'
            )
        }
        assertNonNegativeAmount(input.stakingAllowanceRao, 'Staking allowance')
        if (input.stakingAllowanceRao < amountRao + alphaTopUpRao) {
            steps.push(
                transactionStep(
                    'approval',
                    `Approve staked ${asset.label} for the ForeverMoney gateway`,
                    subtensor.chainId,
                    sender,
                    subtensor.contracts.stakingPrecompile,
                    encodeFunctionData({
                        abi: stakingAbi,
                        functionName: 'approve',
                        args: [
                            subtensor.contracts.gateway,
                            netuid!,
                            amountRao + alphaTopUpRao,
                        ],
                    }),
                    0n
                )
            )
        }
    } else if (
        input.netuid !== undefined ||
        input.stakingAllowanceRao !== undefined
    ) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'netuid and staking allowance are only valid for staked TAO.'
        )
    }
    const taoAmount = input.source === 'liquid' ? input.amountWei : 0n
    const stakedAlphaRao = input.source === 'staked' ? amountRao : 0n
    const pulls = stakePullsFor(input, amountRao)
    const value = taoAmount + taoTopUp + feeWithBuffer(input.exactNetworkFeeWei)
    assertNonNegativeAmount(value, 'Transaction value')
    steps.push(
        transactionStep(
            'transaction',
            `Bridge ${input.source} ${asset.label} from Subtensor to ${evm.name}`,
            subtensor.chainId,
            sender,
            subtensor.contracts.gateway,
            encodeHubBridge(
                evm.ccipSelector,
                asset.subtensorToken,
                recipient,
                taoAmount,
                stakedAlphaRao,
                input.amountWei,
                partnerFee,
                pulls
            ),
            value,
            input.estimatedBridgeGas === undefined
                ? undefined
                : gasLimitWithBuffer(input.estimatedBridgeGas)
        )
    )
    return createTransactionPlan({
        action:
            evm.key === 'base'
                ? 'bridge.subtensor-to-base'
                : 'bridge.subtensor-to-robinhood',
        summary: `Bridge ${input.amountWei} wei of ${input.source} ${asset.label} from Subtensor to ${recipient} on ${evm.name}.${partnerFeeSummary(
            input.source === 'liquid'
                ? taoTopUp
                : alphaTopUpRao * EVM_WEI_PER_RAO,
            input.source === 'liquid' ? 'TAO' : `staked ${asset.label}`,
            partnerFee
        )}`,
        steps,
    })
}
export function buildSubtensorToBasePlan(
    input: BuildSubtensorToBasePlanRequest
): TransactionPlan {
    return buildSubtensorToEvmPlan({ ...input, evmChain: 'base' })
}
export async function prepareEvmToSubtensor(
    provider: PublicClient,
    input: EvmToSubtensorRequest
): Promise<BridgePreparation> {
    const sender = normalizeEvmAddress(input.sender)
    const asset = bridgeAsset(input.evmChain, input.asset)
    assertDelivery(input.delivery)
    assertAssetMode(input.asset, input.delivery)
    assertBaseToSubtensorAmount(input.amountWei, input.delivery)
    const destination = normalizeSS58(input.destination)
    const evm = getForeverMoneyEvmDeployment(input.evmChain)
    const exit = {
        ss58: ss58ToPublicKey(destination),
        evmFallback: sender,
        wantLiquid: input.delivery === 'liquid',
        minTaoOut: input.amountWei,
    }
    const partnerFee = resolvePartnerFee(
        input.partnerFee,
        evm.contracts.gateway
    )
    const cut = partnerFeeCut(input.amountWei, partnerFee.bps)
    const [allowanceWei, exactNetworkFeeWei] = await Promise.all([
        provider.readContract({
            address: asset.evmToken,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [sender, evm.contracts.gateway],
        }),
        partnerFee.bps === 0
            ? provider.readContract({
                  address: evm.contracts.gateway,
                  abi: spokeAbi,
                  functionName: 'quoteBridgeToFinney',
                  args: [asset.evmToken, input.amountWei, exit],
              })
            : quoteSpokeWithFee(
                  provider,
                  evm.contracts.gateway,
                  asset.evmToken,
                  input.amountWei,
                  exit,
                  partnerFee
              ),
    ])
    let estimatedBridgeGas: bigint | undefined
    if (allowanceWei >= input.amountWei + cut) {
        const data = encodeSpokeBridge(
            asset.evmToken,
            input.amountWei,
            exit,
            partnerFee
        )
        estimatedBridgeGas = await provider.estimateGas({
            account: sender,
            to: evm.contracts.gateway,
            data,
            value: feeWithBuffer(exactNetworkFeeWei),
        })
    }
    const plan = buildEvmToSubtensorPlan({
        ...input,
        allowanceWei,
        exactNetworkFeeWei,
        ...(estimatedBridgeGas === undefined ? {} : { estimatedBridgeGas }),
    })
    return Object.freeze({
        exactNetworkFeeWei,
        transactionValueWei: feeWithBuffer(exactNetworkFeeWei),
        partnerFeeWei: cut,
        plan,
    })
}
export function prepareBaseToSubtensor(
    provider: PublicClient,
    input: BaseToSubtensorRequest
): Promise<BridgePreparation> {
    return prepareEvmToSubtensor(provider, { ...input, evmChain: 'base' })
}
export async function prepareSubtensorToEvm(
    provider: PublicClient,
    input: SubtensorToEvmRequest
): Promise<BridgePreparation> {
    const sender = normalizeEvmAddress(input.sender)
    const recipient = normalizeEvmAddress(input.recipient)
    const asset = bridgeAsset(input.evmChain, input.asset)
    assertSource(input.source)
    assertAssetMode(input.asset, input.source)
    const netuid = sourceNetuid(input)
    assertSubtensorToEvmAmount(input.amountWei, input.source)
    const { subtensor } = foreverMoneyDeployment
    const evm = getForeverMoneyEvmDeployment(input.evmChain)
    const partnerFee = resolvePartnerFee(
        input.partnerFee,
        subtensor.contracts.gateway
    )
    const taoAmount = input.source === 'liquid' ? input.amountWei : 0n
    const stakedAlphaRao =
        input.source === 'staked' ? input.amountWei / EVM_WEI_PER_RAO : 0n
    const exactNetworkFeeWei =
        partnerFee.bps === 0
            ? await provider.readContract({
                  address: subtensor.contracts.gateway,
                  abi: alphaAbi,
                  functionName: 'quoteBridgeOut',
                  args: [
                      evm.ccipSelector,
                      asset.subtensorToken,
                      recipient,
                      input.amountWei,
                  ],
              })
            : (
                  await quoteHubWithFee(
                      provider,
                      subtensor.contracts.gateway,
                      evm.ccipSelector,
                      asset.subtensorToken,
                      recipient,
                      input.amountWei,
                      taoAmount,
                      stakedAlphaRao,
                      partnerFee
                  )
              ).networkFee
    let stakingAllowanceRao: bigint | undefined
    if (input.source === 'staked') {
        stakingAllowanceRao = await provider.readContract({
            address: subtensor.contracts.stakingPrecompile,
            abi: stakingAbi,
            functionName: 'allowance',
            args: [sender, subtensor.contracts.gateway, netuid!],
        })
    }
    const alphaTopUpRao = partnerFeeCut(stakedAlphaRao, partnerFee.bps)
    const taoTopUp = partnerFeeTaoTopUp(taoAmount, partnerFee.bps)
    const value = taoAmount + taoTopUp + feeWithBuffer(exactNetworkFeeWei)
    assertNonNegativeAmount(value, 'Transaction value')
    let estimatedBridgeGas: bigint | undefined
    if (
        input.source === 'liquid' ||
        (stakingAllowanceRao !== undefined &&
            stakingAllowanceRao >= stakedAlphaRao + alphaTopUpRao)
    ) {
        estimatedBridgeGas = await provider.estimateGas({
            account: sender,
            to: subtensor.contracts.gateway,
            data: encodeHubBridge(
                evm.ccipSelector,
                asset.subtensorToken,
                recipient,
                taoAmount,
                stakedAlphaRao,
                input.amountWei,
                partnerFee,
                stakePullsFor(input, stakedAlphaRao)
            ),
            value,
        })
    }
    const plan = buildSubtensorToEvmPlan({
        ...input,
        exactNetworkFeeWei,
        ...(stakingAllowanceRao === undefined ? {} : { stakingAllowanceRao }),
        ...(estimatedBridgeGas === undefined ? {} : { estimatedBridgeGas }),
    })
    return Object.freeze({
        exactNetworkFeeWei,
        transactionValueWei: value,
        partnerFeeWei:
            input.source === 'liquid'
                ? taoTopUp
                : alphaTopUpRao * EVM_WEI_PER_RAO,
        plan,
    })
}
export function prepareSubtensorToBase(
    provider: PublicClient,
    input: SubtensorToBaseRequest
): Promise<BridgePreparation> {
    return prepareSubtensorToEvm(provider, { ...input, evmChain: 'base' })
}
