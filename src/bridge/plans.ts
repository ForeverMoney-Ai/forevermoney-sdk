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
import { assertNonNegativeAmount } from '../core/validation.js'
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
export interface EvmToSubtensorRequest {
    readonly evmChain: ForeverMoneyEvmChain
    readonly sender: string
    readonly amountWei: bigint
    readonly destination: string
    readonly delivery: SubtensorDelivery
}
export interface SubtensorToEvmRequest {
    readonly evmChain: ForeverMoneyEvmChain
    readonly sender: string
    readonly recipient: string
    readonly amountWei: bigint
    readonly source: SubtensorSource
    readonly netuid?: bigint
}
export type BaseToSubtensorRequest = Omit<EvmToSubtensorRequest, 'evmChain'>
export type SubtensorToBaseRequest = Omit<SubtensorToEvmRequest, 'evmChain'>
export interface BridgePreparation {
    readonly exactNetworkFeeWei: bigint
    readonly transactionValueWei: bigint
    readonly plan: TransactionPlan
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
export function buildEvmToSubtensorPlan(
    input: BuildEvmToSubtensorPlanRequest
): TransactionPlan {
    const sender = normalizeEvmAddress(input.sender)
    assertDelivery(input.delivery)
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
    const steps: TransactionStep[] = []
    if (input.allowanceWei < input.amountWei) {
        steps.push(
            transactionStep(
                'approval',
                'Approve wrapped TAO for the ForeverMoney gateway',
                evm.chainId,
                sender,
                evm.contracts.wrappedTao,
                encodeFunctionData({
                    abi: erc20Abi,
                    functionName: 'approve',
                    args: [evm.contracts.gateway, input.amountWei],
                }),
                0n
            )
        )
    }
    const value = feeWithBuffer(input.exactNetworkFeeWei)
    steps.push(
        transactionStep(
            'transaction',
            `Bridge wrapped TAO from ${evm.name} to Subtensor (${input.delivery})`,
            evm.chainId,
            sender,
            evm.contracts.gateway,
            encodeFunctionData({
                abi: spokeAbi,
                functionName: 'bridgeToFinney',
                args: [evm.contracts.wrappedTao, input.amountWei, exit],
            }),
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
        summary: `Bridge ${input.amountWei} wei of wrapped TAO from ${evm.name} to ${destination}.`,
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
    assertSource(input.source)
    assertSubtensorToEvmAmount(input.amountWei, input.source)
    assertNonNegativeAmount(input.exactNetworkFeeWei, 'Network fee')
    const { subtensor } = foreverMoneyDeployment
    const evm = getForeverMoneyEvmDeployment(input.evmChain)
    const amountRao = input.amountWei / EVM_WEI_PER_RAO
    const steps: TransactionStep[] = []
    if (input.source === 'staked') {
        if (input.netuid === undefined) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                'A netuid is required when bridging staked TAO.'
            )
        }
        assertNonNegativeAmount(input.netuid, 'netuid')
        if (input.stakingAllowanceRao === undefined) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                'The staking allowance is required when bridging staked TAO.'
            )
        }
        assertNonNegativeAmount(input.stakingAllowanceRao, 'Staking allowance')
        if (input.stakingAllowanceRao < amountRao) {
            steps.push(
                transactionStep(
                    'approval',
                    'Approve staked TAO for the ForeverMoney gateway',
                    subtensor.chainId,
                    sender,
                    subtensor.contracts.stakingPrecompile,
                    encodeFunctionData({
                        abi: stakingAbi,
                        functionName: 'approve',
                        args: [
                            subtensor.contracts.gateway,
                            input.netuid,
                            amountRao,
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
    const value = taoAmount + feeWithBuffer(input.exactNetworkFeeWei)
    assertNonNegativeAmount(value, 'Transaction value')
    steps.push(
        transactionStep(
            'transaction',
            `Bridge ${input.source} TAO from Subtensor to ${evm.name}`,
            subtensor.chainId,
            sender,
            subtensor.contracts.gateway,
            encodeFunctionData({
                abi: alphaAbi,
                functionName: 'bridgeOut',
                args: [
                    evm.ccipSelector,
                    subtensor.contracts.wrappedTao,
                    recipient,
                    taoAmount,
                    stakedAlphaRao,
                    input.amountWei,
                ],
            }),
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
        summary: `Bridge ${input.amountWei} wei of ${input.source} TAO from Subtensor to ${recipient} on ${evm.name}.`,
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
    assertDelivery(input.delivery)
    assertBaseToSubtensorAmount(input.amountWei, input.delivery)
    const destination = normalizeSS58(input.destination)
    const evm = getForeverMoneyEvmDeployment(input.evmChain)
    const exit = {
        ss58: ss58ToPublicKey(destination),
        evmFallback: sender,
        wantLiquid: input.delivery === 'liquid',
        minTaoOut: input.amountWei,
    }
    const [allowanceWei, exactNetworkFeeWei] = await Promise.all([
        provider.readContract({
            address: evm.contracts.wrappedTao,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [sender, evm.contracts.gateway],
        }),
        provider.readContract({
            address: evm.contracts.gateway,
            abi: spokeAbi,
            functionName: 'quoteBridgeToFinney',
            args: [evm.contracts.wrappedTao, input.amountWei, exit],
        }),
    ])
    let estimatedBridgeGas: bigint | undefined
    if (allowanceWei >= input.amountWei) {
        const data = encodeFunctionData({
            abi: spokeAbi,
            functionName: 'bridgeToFinney',
            args: [evm.contracts.wrappedTao, input.amountWei, exit],
        })
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
    assertSource(input.source)
    assertSubtensorToEvmAmount(input.amountWei, input.source)
    const { subtensor } = foreverMoneyDeployment
    const evm = getForeverMoneyEvmDeployment(input.evmChain)
    const exactNetworkFeeWei = await provider.readContract({
        address: subtensor.contracts.gateway,
        abi: alphaAbi,
        functionName: 'quoteBridgeOut',
        args: [
            evm.ccipSelector,
            subtensor.contracts.wrappedTao,
            recipient,
            input.amountWei,
        ],
    })
    let stakingAllowanceRao: bigint | undefined
    if (input.source === 'staked') {
        if (input.netuid === undefined) {
            throw new ForeverMoneyError(
                'INVALID_TRANSACTION_PLAN',
                'A netuid is required when bridging staked TAO.'
            )
        }
        assertNonNegativeAmount(input.netuid, 'netuid')
        stakingAllowanceRao = await provider.readContract({
            address: subtensor.contracts.stakingPrecompile,
            abi: stakingAbi,
            functionName: 'allowance',
            args: [sender, subtensor.contracts.gateway, input.netuid],
        })
    }
    const taoAmount = input.source === 'liquid' ? input.amountWei : 0n
    const stakedAlphaRao =
        input.source === 'staked' ? input.amountWei / EVM_WEI_PER_RAO : 0n
    const value = taoAmount + feeWithBuffer(exactNetworkFeeWei)
    assertNonNegativeAmount(value, 'Transaction value')
    let estimatedBridgeGas: bigint | undefined
    if (
        input.source === 'liquid' ||
        (stakingAllowanceRao !== undefined &&
            stakingAllowanceRao >= stakedAlphaRao)
    ) {
        estimatedBridgeGas = await provider.estimateGas({
            account: sender,
            to: subtensor.contracts.gateway,
            data: encodeFunctionData({
                abi: alphaAbi,
                functionName: 'bridgeOut',
                args: [
                    evm.ccipSelector,
                    subtensor.contracts.wrappedTao,
                    recipient,
                    taoAmount,
                    stakedAlphaRao,
                    input.amountWei,
                ],
            }),
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
        plan,
    })
}
export function prepareSubtensorToBase(
    provider: PublicClient,
    input: SubtensorToBaseRequest
): Promise<BridgePreparation> {
    return prepareSubtensorToEvm(provider, { ...input, evmChain: 'base' })
}
