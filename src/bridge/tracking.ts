import { trackingClient, type TrackingProvider } from '../core/transport.js'
import {
    decodeEventLog,
    parseAbi,
    TransactionReceiptNotFoundError,
    type Hex,
    type PublicClient,
} from 'viem'
import { ALPHA_GATEWAY_ABI, CCIP_EXECUTION_ABI } from '../abis/index.js'
import { foreverMoneyDeployment } from '../chains/deployment.js'
import { ForeverMoneyError } from '../core/errors.js'
import {
    assertBridgeDirection,
    bridgeMessageIdFromReceipt,
    evmChainFromBridgeDirection,
    isEvmToSubtensorDirection,
    type BridgeDirection,
} from './receipts.js'
import { getForeverMoneyEvmDeployment } from '../chains/deployment.js'
import { normalizeBytes32 } from '../core/validation.js'

const ccipExecutionAbi = parseAbi(CCIP_EXECUTION_ABI)
const alphaGatewayAbi = parseAbi(ALPHA_GATEWAY_ABI)

export type CcipDeliveryStatus = 'failure' | 'recovery' | 'success' | 'waiting'

export interface CcipDeliveryStatusRequest {
    readonly direction: BridgeDirection
    readonly messageId: string
    readonly fromBlock: number
}

export interface CcipDeliveryCheckpoint {
    readonly direction: BridgeDirection
    readonly destinationChainId: number
    readonly fromBlock: number
}

export type BridgeSourceTransactionStatus = 'confirmed' | 'failed' | 'pending'

export interface BridgeSourceStatusRequest {
    readonly direction: BridgeDirection
    readonly transactionHash: string
}

interface BridgeSourceStatusBase {
    readonly direction: BridgeDirection
    readonly sourceChainId: number
    readonly transactionHash: string
}

export type BridgeSourceStatus =
    | (BridgeSourceStatusBase & {
          readonly status: 'confirmed'
          readonly messageId: string
      })
    | (BridgeSourceStatusBase & {
          readonly status: 'failed' | 'pending'
          readonly messageId: null
      })

export function destinationChainId(direction: BridgeDirection): number {
    assertBridgeDirection(direction)
    const evm = getForeverMoneyEvmDeployment(
        evmChainFromBridgeDirection(direction)
    )
    return isEvmToSubtensorDirection(direction)
        ? foreverMoneyDeployment.subtensor.chainId
        : evm.chainId
}

export function sourceChainId(direction: BridgeDirection): number {
    assertBridgeDirection(direction)
    const evm = getForeverMoneyEvmDeployment(
        evmChainFromBridgeDirection(direction)
    )
    return isEvmToSubtensorDirection(direction)
        ? evm.chainId
        : foreverMoneyDeployment.subtensor.chainId
}

async function assertProviderChain(
    provider: PublicClient,
    expectedChainId: number,
    label: string
): Promise<void> {
    const chainId = await provider.getChainId()
    if (chainId !== expectedChainId) {
        throw new ForeverMoneyError(
            'CHAIN_MISMATCH',
            `${label} transport reported chain ID ${chainId}; expected ${expectedChainId}.`,
            {
                expectedChainId,
                actualChainId: chainId.toString(),
            }
        )
    }
}

async function assertDestinationProvider(
    provider: PublicClient,
    direction: BridgeDirection
): Promise<number> {
    const expectedChainId = destinationChainId(direction)
    await assertProviderChain(provider, expectedChainId, 'Bridge destination')
    return expectedChainId
}

export async function getBridgeSourceStatus(
    provider: TrackingProvider,
    input: BridgeSourceStatusRequest
): Promise<BridgeSourceStatus> {
    const client = trackingClient(provider)
    const expectedChainId = sourceChainId(input.direction)
    const transactionHash = normalizeBytes32(
        input.transactionHash,
        'Transaction hash'
    )
    await assertProviderChain(client, expectedChainId, 'Bridge source')
    const receipt = await receiptOrNull(client, transactionHash)
    if (receipt === null) {
        return Object.freeze({
            direction: input.direction,
            sourceChainId: expectedChainId,
            transactionHash,
            status: 'pending',
            messageId: null,
        })
    }
    if (receipt.status === 'reverted') {
        return Object.freeze({
            direction: input.direction,
            sourceChainId: expectedChainId,
            transactionHash,
            status: 'failed',
            messageId: null,
        })
    }
    if (receipt.status !== 'success') {
        throw new ForeverMoneyError(
            'INVALID_PROVIDER_RESPONSE',
            'The bridge source receipt has an invalid status.'
        )
    }
    const messageId = bridgeMessageIdFromReceipt(input.direction, receipt)
    if (messageId === null) {
        throw new ForeverMoneyError(
            'INVALID_PROVIDER_RESPONSE',
            'The confirmed bridge source receipt does not contain its canonical gateway event.'
        )
    }
    return Object.freeze({
        direction: input.direction,
        sourceChainId: expectedChainId,
        transactionHash,
        status: 'confirmed',
        messageId,
    })
}

export async function getCcipDeliveryCheckpoint(
    provider: TrackingProvider,
    direction: BridgeDirection
): Promise<CcipDeliveryCheckpoint> {
    const client = trackingClient(provider)
    const expectedChainId = await assertDestinationProvider(client, direction)
    const blockNumber = await client.getBlockNumber({ cacheTime: 0 })
    const fromBlock = Number(blockNumber)
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) {
        throw new ForeverMoneyError(
            'INVALID_PROVIDER_RESPONSE',
            'Bridge destination transport returned an invalid block number.'
        )
    }
    return Object.freeze({
        direction,
        destinationChainId: expectedChainId,
        fromBlock,
    })
}

export async function getCcipDeliveryStatus(
    provider: TrackingProvider,
    input: CcipDeliveryStatusRequest
): Promise<CcipDeliveryStatus> {
    const client = trackingClient(provider)
    const expectedChainId = destinationChainId(input.direction)
    const messageId = normalizeBytes32(input.messageId, 'CCIP message ID')
    if (!Number.isSafeInteger(input.fromBlock) || input.fromBlock < 0) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'CCIP fromBlock must be a non-negative safe integer.'
        )
    }
    await assertProviderChain(client, expectedChainId, 'Bridge destination')

    const evmChain = evmChainFromBridgeDirection(input.direction)
    const evm = getForeverMoneyEvmDeployment(evmChain)
    const evmToSubtensor = isEvmToSubtensorDirection(input.direction)
    const sourceSelector = evmToSubtensor
        ? evm.ccipSelector
        : foreverMoneyDeployment.subtensor.ccipSelector
    const offRamp = evmToSubtensor
        ? evmChain === 'base'
            ? foreverMoneyDeployment.subtensor.contracts.ccipOffRampFromBase
            : foreverMoneyDeployment.subtensor.contracts
                  .ccipOffRampFromRobinhood
        : evm.contracts.ccipOffRampFromSubtensor
    const logs = await client.getLogs({
        address: offRamp,
        fromBlock: BigInt(input.fromBlock),
        toBlock: 'latest',
        event: ccipExecutionAbi[0],
        args: { sourceChainSelector: sourceSelector, messageId },
        strict: true,
    })
    const latest = logs.at(-1)
    if (latest === undefined) return 'waiting'

    const state = latest.args.state
    if (state === 3) return 'failure'
    if (state !== 2) return 'waiting'
    if (!evmToSubtensor) return 'success'

    const receipt = await receiptOrNull(client, latest.transactionHash!)
    if (receipt === null) {
        throw new ForeverMoneyError(
            'INVALID_PROVIDER_RESPONSE',
            'The CCIP execution receipt is unavailable.'
        )
    }
    const subtensorGateways = [
        foreverMoneyDeployment.subtensor.contracts.legacyGateway,
        foreverMoneyDeployment.subtensor.contracts.gateway,
    ]
    for (const log of receipt.logs) {
        if (
            !subtensorGateways.some(
                (gateway) => log.address.toLowerCase() === gateway.toLowerCase()
            )
        ) {
            continue
        }
        try {
            const { eventName } = decodeEventLog({
                abi: alphaGatewayAbi,
                data: log.data,
                topics: log.topics,
            })
            // V5 can report an undelivered message without a Claimable event.
            if (eventName === 'Claimable' || eventName === 'NotDelivered') {
                return 'recovery'
            }
        } catch {
            // The execution receipt can contain other gateway events.
        }
    }
    return 'success'
}

async function receiptOrNull(provider: PublicClient, hash: Hex) {
    try {
        return await provider.getTransactionReceipt({ hash })
    } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null
        throw error
    }
}
