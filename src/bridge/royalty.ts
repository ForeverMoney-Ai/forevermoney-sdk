import {
    concatHex,
    encodeAbiParameters,
    encodeFunctionData,
    parseAbi,
    parseAbiParameters,
    zeroAddress,
    type Hex,
    type PublicClient,
} from 'viem'
import {
    CCIP_ROUTER_ABI,
    CCIP_TOKEN_POOL_ABI,
    ERC20_ABI,
    ROYALTY_GATEWAY_ABI,
} from '../abis/index.js'
import { normalizeEvmAddress } from '../core/addresses.js'
import { feeWithBuffer, gasLimitWithBuffer } from '../core/amounts.js'
import {
    berachainRoyaltyAssets,
    foreverMoneyDeployment,
    type BerachainRoyaltyAsset,
} from '../chains/deployment.js'
import { ForeverMoneyError } from '../core/errors.js'
import {
    createTransactionPlan,
    type TransactionPlan,
    type TransactionStep,
} from '../core/plans.js'
import {
    assertNonNegativeAmount,
    assertPositiveAmount,
} from '../core/validation.js'

const erc20Abi = parseAbi(ERC20_ABI)
const routerAbi = parseAbi(CCIP_ROUTER_ABI)
const poolAbi = parseAbi(CCIP_TOKEN_POOL_ABI)
const gatewayAbi = parseAbi(ROYALTY_GATEWAY_ABI)

/**
 * CCIP gas for the Berachain RoyaltyGateway's `ccipReceive`, which unwraps and
 * pays the recipient. A delivery measures ~40k gas; 150k leaves ~3x headroom.
 */
export const BASE_TO_BERACHAIN_DESTINATION_GAS_LIMIT = 150_000n
// GenericExtraArgsV2: bytes4(keccak256("CCIP EVMExtraArgsV2")).
const EXTRA_ARGS_V2_TAG: Hex = '0x181dcf10'
const EXTRA_ARGS_V2 = parseAbiParameters(
    'uint256 gasLimit, bool allowOutOfOrderExecution'
)
const ADDRESS_PARAM = parseAbiParameters('address')

export interface RoyaltyBridgeRequest {
    readonly asset: BerachainRoyaltyAsset
    readonly sender: string
    readonly recipient: string
    readonly amountWei: bigint
}

export interface BuildRoyaltyBridgePlanRequest extends RoyaltyBridgeRequest {
    readonly allowanceWei: bigint
    readonly exactNetworkFeeWei: bigint
    readonly estimatedBridgeGas?: bigint
}

export interface RoyaltyBridgePreparation {
    readonly exactNetworkFeeWei: bigint
    readonly transactionValueWei: bigint
    readonly plan: TransactionPlan
}

export function royaltyAsset(key: BerachainRoyaltyAsset) {
    const asset = berachainRoyaltyAssets[key]
    if (asset === undefined) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Unknown Berachain royalty asset.',
            { asset: String(key) }
        )
    }
    return asset
}

function step(
    kind: TransactionStep['kind'],
    label: string,
    chainId: number,
    from: string,
    to: string,
    data: Hex,
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

function approval(
    chainId: number,
    sender: string,
    token: Hex,
    spender: Hex,
    amountWei: bigint,
    label: string
): TransactionStep {
    return step(
        'approval',
        label,
        chainId,
        sender,
        token,
        encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [spender, amountWei],
        }),
        0n
    )
}

function assertRequest(input: RoyaltyBridgeRequest) {
    const asset = royaltyAsset(input.asset)
    assertPositiveAmount(input.amountWei, 'Bridge amount')
    return {
        asset,
        sender: normalizeEvmAddress(input.sender),
        recipient: normalizeEvmAddress(input.recipient),
    }
}

function assertPlanInputs(input: BuildRoyaltyBridgePlanRequest) {
    assertNonNegativeAmount(input.allowanceWei, 'Token allowance')
    assertNonNegativeAmount(input.exactNetworkFeeWei, 'Network fee')
}

/**
 * The CCIP message a Base to Berachain send carries: the bridge token, to the
 * RoyaltyGateway, with the real recipient in `data`, so delivery unwraps and
 * pays out the real token in the same execution. The fee is paid in ETH.
 */
function baseToBerachainMessage(
    bridgeToken: Hex,
    amountWei: bigint,
    recipient: Hex
) {
    return {
        receiver: encodeAbiParameters(ADDRESS_PARAM, [
            foreverMoneyDeployment.berachain.contracts.royaltyGateway,
        ]),
        data: encodeAbiParameters(ADDRESS_PARAM, [recipient]),
        tokenAmounts: [{ token: bridgeToken, amount: amountWei }],
        feeToken: zeroAddress,
        extraArgs: concatHex([
            EXTRA_ARGS_V2_TAG,
            encodeAbiParameters(EXTRA_ARGS_V2, [
                BASE_TO_BERACHAIN_DESTINATION_GAS_LIMIT,
                true,
            ]),
        ]),
    } as const
}

function encodeBaseToBerachain(
    bridgeToken: Hex,
    amountWei: bigint,
    recipient: Hex
): Hex {
    return encodeFunctionData({
        abi: routerAbi,
        functionName: 'ccipSend',
        args: [
            foreverMoneyDeployment.berachain.ccipSelector,
            baseToBerachainMessage(bridgeToken, amountWei, recipient),
        ],
    })
}

function encodeBerachainToBase(
    bridgeToken: Hex,
    amountWei: bigint,
    recipient: Hex
): Hex {
    return encodeFunctionData({
        abi: gatewayAbi,
        functionName: 'wrapAndSend',
        args: [bridgeToken, amountWei, recipient],
    })
}

/**
 * Base to Berachain: approve the Base router for the bridge token, then
 * `ccipSend` it to the RoyaltyGateway, which pays the recipient the real token
 * on Berachain. Delivery waits for Base finality (~20 minutes).
 *
 * The router keeps the whole `msg.value` as the fee, so the 2% buffer is paid
 * rather than refunded; it covers a fee change between quote and send.
 */
export function buildBaseToBerachainPlan(
    input: BuildRoyaltyBridgePlanRequest
): TransactionPlan {
    const { asset, sender, recipient } = assertRequest(input)
    assertPlanInputs(input)
    const { base, berachain } = foreverMoneyDeployment
    const steps: TransactionStep[] = []
    if (input.allowanceWei < input.amountWei) {
        steps.push(
            approval(
                base.chainId,
                sender,
                asset.bridgeToken,
                base.contracts.ccipRouter,
                input.amountWei,
                `Approve ${asset.symbol} for the CCIP router`
            )
        )
    }
    steps.push(
        step(
            'transaction',
            `Bridge ${asset.symbol} from Base to ${berachain.name}`,
            base.chainId,
            sender,
            base.contracts.ccipRouter,
            encodeBaseToBerachain(
                asset.bridgeToken,
                input.amountWei,
                recipient
            ),
            feeWithBuffer(input.exactNetworkFeeWei),
            input.estimatedBridgeGas === undefined
                ? undefined
                : gasLimitWithBuffer(input.estimatedBridgeGas)
        )
    )
    return createTransactionPlan({
        action: 'bridge.base-to-berachain',
        summary: `Bridge ${input.amountWei} wei of ${asset.symbol} from Base to ${recipient} on ${berachain.name}.`,
        steps,
    })
}

/**
 * Berachain to Base: approve the RoyaltyGateway for the real token, then
 * `wrapAndSend`, which wraps it 1:1 and sends the wrapper to the recipient on
 * Base (~30 seconds). The gateway refunds any surplus BERA.
 */
export function buildBerachainToBasePlan(
    input: BuildRoyaltyBridgePlanRequest
): TransactionPlan {
    const { asset, sender, recipient } = assertRequest(input)
    assertPlanInputs(input)
    const { berachain } = foreverMoneyDeployment
    const gateway = berachain.contracts.royaltyGateway
    const steps: TransactionStep[] = []
    if (input.allowanceWei < input.amountWei) {
        steps.push(
            approval(
                berachain.chainId,
                sender,
                asset.underlying,
                gateway,
                input.amountWei,
                `Approve ${asset.symbol} for the ForeverMoney royalty gateway`
            )
        )
    }
    steps.push(
        step(
            'transaction',
            `Bridge ${asset.symbol} from ${berachain.name} to Base`,
            berachain.chainId,
            sender,
            gateway,
            encodeBerachainToBase(
                asset.bridgeToken,
                input.amountWei,
                recipient
            ),
            feeWithBuffer(input.exactNetworkFeeWei),
            input.estimatedBridgeGas === undefined
                ? undefined
                : gasLimitWithBuffer(input.estimatedBridgeGas)
        )
    )
    return createTransactionPlan({
        action: 'bridge.berachain-to-base',
        summary: `Bridge ${input.amountWei} wei of ${asset.symbol} from ${berachain.name} to ${recipient} on Base.`,
        steps,
    })
}

// A send above the source pool's outbound bucket reverts at the source.
async function assertWithinRateLimit(
    provider: PublicClient,
    pool: Hex,
    destinationSelector: bigint,
    amountWei: bigint
) {
    const state = await provider.readContract({
        address: pool,
        abi: poolAbi,
        functionName: 'getCurrentOutboundRateLimiterState',
        args: [destinationSelector],
    })
    if (state.isEnabled && amountWei > state.tokens) {
        throw new ForeverMoneyError(
            'AMOUNT_ABOVE_RATE_LIMIT',
            'The amount exceeds what the bridge can carry right now; try a smaller amount or wait for the limit to refill.',
            {
                availableWei: state.tokens.toString(),
                refillWeiPerSecond: state.rate.toString(),
            }
        )
    }
}

export async function prepareBaseToBerachain(
    provider: PublicClient,
    input: RoyaltyBridgeRequest
): Promise<RoyaltyBridgePreparation> {
    const { asset, sender, recipient } = assertRequest(input)
    const { base, berachain } = foreverMoneyDeployment
    const [allowanceWei, exactNetworkFeeWei] = await Promise.all([
        provider.readContract({
            address: asset.bridgeToken,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [sender, base.contracts.ccipRouter],
        }),
        provider.readContract({
            address: base.contracts.ccipRouter,
            abi: routerAbi,
            functionName: 'getFee',
            args: [
                berachain.ccipSelector,
                baseToBerachainMessage(
                    asset.bridgeToken,
                    input.amountWei,
                    recipient
                ),
            ],
        }),
        assertWithinRateLimit(
            provider,
            asset.pool,
            berachain.ccipSelector,
            input.amountWei
        ),
    ])
    const transactionValueWei = feeWithBuffer(exactNetworkFeeWei)
    const estimatedBridgeGas =
        allowanceWei >= input.amountWei
            ? await provider.estimateGas({
                  account: sender,
                  to: base.contracts.ccipRouter,
                  data: encodeBaseToBerachain(
                      asset.bridgeToken,
                      input.amountWei,
                      recipient
                  ),
                  value: transactionValueWei,
              })
            : undefined
    return Object.freeze({
        exactNetworkFeeWei,
        transactionValueWei,
        plan: buildBaseToBerachainPlan({
            ...input,
            allowanceWei,
            exactNetworkFeeWei,
            ...(estimatedBridgeGas === undefined ? {} : { estimatedBridgeGas }),
        }),
    })
}

export async function prepareBerachainToBase(
    provider: PublicClient,
    input: RoyaltyBridgeRequest
): Promise<RoyaltyBridgePreparation> {
    const { asset, sender, recipient } = assertRequest(input)
    const { base, berachain } = foreverMoneyDeployment
    const gateway = berachain.contracts.royaltyGateway
    const [allowanceWei, exactNetworkFeeWei] = await Promise.all([
        provider.readContract({
            address: asset.underlying,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [sender, gateway],
        }),
        provider.readContract({
            address: gateway,
            abi: gatewayAbi,
            functionName: 'quoteWrapAndSend',
            args: [asset.bridgeToken, input.amountWei, recipient],
        }),
        assertWithinRateLimit(
            provider,
            asset.pool,
            base.ccipSelector,
            input.amountWei
        ),
    ])
    const transactionValueWei = feeWithBuffer(exactNetworkFeeWei)
    const estimatedBridgeGas =
        allowanceWei >= input.amountWei
            ? await provider.estimateGas({
                  account: sender,
                  to: gateway,
                  data: encodeBerachainToBase(
                      asset.bridgeToken,
                      input.amountWei,
                      recipient
                  ),
                  value: transactionValueWei,
              })
            : undefined
    return Object.freeze({
        exactNetworkFeeWei,
        transactionValueWei,
        plan: buildBerachainToBasePlan({
            ...input,
            allowanceWei,
            exactNetworkFeeWei,
            ...(estimatedBridgeGas === undefined ? {} : { estimatedBridgeGas }),
        }),
    })
}
