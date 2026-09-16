import { eventLog } from '../test-utils.js'
import {
    parseAbi,
    TransactionReceiptNotFoundError,
    type PublicClient,
    type Hex,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
    ALPHA_GATEWAY_ABI,
    CCIP_EXECUTION_ABI,
    SPOKE_GATEWAY_ABI,
} from '../abis/index.js'
import {
    destinationChainId,
    getBridgeSourceStatus,
    getCcipDeliveryCheckpoint,
    getCcipDeliveryStatus,
    sourceChainId,
} from './tracking.js'
import { foreverMoneyDeployment } from '../chains/deployment.js'
const executionAbi = parseAbi(CCIP_EXECUTION_ABI)
const alphaGatewayAbi = parseAbi(ALPHA_GATEWAY_ABI)
const spokeGatewayAbi = parseAbi(SPOKE_GATEWAY_ABI)
const messageId = `0x${'11'.repeat(32)}`
const messageHash = `0x${'22'.repeat(32)}`
const transactionHash = `0x${'33'.repeat(32)}`
function executionLog(state: number) {
    const event = executionAbi.find(
        (item) => item.type === 'event' && item.name === 'ExecutionStateChanged'
    )!
    if (event === null) throw new Error('ExecutionStateChanged ABI is missing.')
    const encoded = eventLog(executionAbi, event.name, [
        1n,
        2n,
        messageId,
        messageHash,
        state,
        '0x',
        100n,
    ])
    return { ...encoded, transactionHash, args: { state } }
}
function claimableLog(
    address = foreverMoneyDeployment.subtensor.contracts.legacyGateways[0]!
) {
    const event = alphaGatewayAbi.find(
        (item) => item.type === 'event' && item.name === 'Claimable'
    )!
    if (event === null) throw new Error('Claimable ABI is missing.')
    const encoded = eventLog(alphaGatewayAbi, event.name, [
        foreverMoneyDeployment.subtensor.contracts.wrappedTao,
        '0x1111111111111111111111111111111111111111',
        10n,
        20n,
    ])
    return { address, ...encoded }
}
function notDeliveredLog(
    address = foreverMoneyDeployment.subtensor.contracts.legacyGateways[0]!
) {
    const encoded = eventLog(alphaGatewayAbi, 'NotDelivered', [
        foreverMoneyDeployment.base.ccipSelector,
        foreverMoneyDeployment.subtensor.contracts.wrappedTao,
        10n,
        1,
    ])
    return { address, ...encoded }
}
function bridgeSourceLog() {
    const event = spokeGatewayAbi.find(
        (item) => item.type === 'event' && item.name === 'BridgedToFinney'
    )!
    if (event === null) throw new Error('BridgedToFinney ABI is missing.')
    const encoded = eventLog(spokeGatewayAbi, event.name, [
        foreverMoneyDeployment.base.contracts.wrappedTao,
        '0x1111111111111111111111111111111111111111',
        `0x${'44'.repeat(32)}`,
        10n,
        messageId,
    ])
    return {
        address: foreverMoneyDeployment.base.contracts.legacyGateways[0]!,
        ...encoded,
    }
}
function provider(
    options: {
        chainId?: number
        blockNumber?: number
        logs?: readonly unknown[]
        receiptLogs?: readonly unknown[]
        receiptAvailable?: boolean
        receiptStatus?: number | null
    } = {}
): PublicClient {
    return {
        getChainId: vi.fn(async () => options.chainId ?? 964),
        getBlockNumber: vi.fn(async () => BigInt(options.blockNumber ?? 123)),
        getLogs: vi.fn(async () => options.logs ?? []),
        getTransactionReceipt: vi.fn(async () => {
            if (options.receiptAvailable === false)
                throw new TransactionReceiptNotFoundError({
                    hash: transactionHash as Hex,
                })
            return {
                logs: options.receiptLogs ?? [],
                status:
                    options.receiptStatus === 0
                        ? 'reverted'
                        : options.receiptStatus === 1
                          ? 'success'
                          : undefined,
            }
        }),
    } as unknown as PublicClient
}
describe('CCIP delivery lifecycle', () => {
    it('maps canonical Robinhood lane directions to their chain IDs', () => {
        expect(destinationChainId('robinhood-to-subtensor')).toBe(964)
        expect(sourceChainId('robinhood-to-subtensor')).toBe(4663)
        expect(destinationChainId('subtensor-to-robinhood')).toBe(4663)
        expect(sourceChainId('subtensor-to-robinhood')).toBe(964)
    })
    it('resolves pending, failed, and confirmed source transactions', async () => {
        const request = {
            direction: 'base-to-subtensor' as const,
            transactionHash,
        }
        await expect(
            getBridgeSourceStatus(
                provider({ chainId: 8453, receiptAvailable: false }),
                request
            )
        ).resolves.toMatchObject({ status: 'pending', messageId: null })
        await expect(
            getBridgeSourceStatus(
                provider({ chainId: 8453, receiptStatus: 0 }),
                request
            )
        ).resolves.toMatchObject({ status: 'failed', messageId: null })
        await expect(
            getBridgeSourceStatus(
                provider({
                    chainId: 8453,
                    receiptStatus: 1,
                    receiptLogs: [bridgeSourceLog()],
                }),
                request
            )
        ).resolves.toMatchObject({ status: 'confirmed', messageId })
    })
    it('rejects a confirmed source receipt without the canonical event', async () => {
        await expect(
            getBridgeSourceStatus(
                provider({ chainId: 8453, receiptStatus: 1 }),
                {
                    direction: 'base-to-subtensor',
                    transactionHash,
                }
            )
        ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    })
    it('captures a chain-verified destination checkpoint', async () => {
        await expect(
            getCcipDeliveryCheckpoint(provider(), 'base-to-subtensor')
        ).resolves.toEqual({
            direction: 'base-to-subtensor',
            destinationChainId: 964,
            fromBlock: 123,
        })
    })
    it('rejects a provider connected to the wrong destination chain', async () => {
        await expect(
            getCcipDeliveryStatus(provider({ chainId: 8453 }), {
                direction: 'base-to-subtensor',
                messageId,
                fromBlock: 0,
            })
        ).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' })
    })
    it('returns waiting until CCIP reports a terminal state', async () => {
        const destinationProvider = provider()
        await expect(
            getCcipDeliveryStatus(destinationProvider, {
                direction: 'base-to-subtensor',
                messageId,
                fromBlock: 10,
            })
        ).resolves.toBe('waiting')
        expect(destinationProvider.getLogs).toHaveBeenCalledWith({
            address:
                foreverMoneyDeployment.subtensor.contracts.ccipOffRampFromBase,
            fromBlock: 10n,
            toBlock: 'latest',
            event: executionAbi[0],
            args: {
                sourceChainSelector: foreverMoneyDeployment.base.ccipSelector,
                messageId,
            },
            strict: true,
        })
        await expect(
            getCcipDeliveryStatus(provider({ logs: [executionLog(1)] }), {
                direction: 'base-to-subtensor',
                messageId,
                fromBlock: 10,
            })
        ).resolves.toBe('waiting')
    })
    it('reports CCIP failure and successful Subtensor-to-Base delivery', async () => {
        await expect(
            getCcipDeliveryStatus(provider({ logs: [executionLog(3)] }), {
                direction: 'base-to-subtensor',
                messageId,
                fromBlock: 10,
            })
        ).resolves.toBe('failure')
        const baseProvider = provider({
            chainId: 8453,
            logs: [executionLog(2)],
        })
        await expect(
            getCcipDeliveryStatus(baseProvider, {
                direction: 'subtensor-to-base',
                messageId,
                fromBlock: 10,
            })
        ).resolves.toBe('success')
        expect(baseProvider.getLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                address:
                    foreverMoneyDeployment.base.contracts
                        .ccipOffRampFromSubtensor,
            })
        )
    })
    it('uses the reviewed Robinhood off-ramp for delivery status', async () => {
        const robinhoodProvider = provider({
            chainId: 4663,
            logs: [executionLog(2)],
        })
        await expect(
            getCcipDeliveryStatus(robinhoodProvider, {
                direction: 'subtensor-to-robinhood',
                messageId,
                fromBlock: 10,
            })
        ).resolves.toBe('success')
        expect(robinhoodProvider.getLogs).toHaveBeenCalledWith(
            expect.objectContaining({
                address:
                    foreverMoneyDeployment.robinhood.contracts
                        .ccipOffRampFromSubtensor,
            })
        )
    })
    it('distinguishes Base-to-Subtensor recovery from successful delivery', async () => {
        await expect(
            getCcipDeliveryStatus(
                provider({
                    logs: [executionLog(2)],
                    receiptLogs: [claimableLog()],
                }),
                {
                    direction: 'base-to-subtensor',
                    messageId,
                    fromBlock: 10,
                }
            )
        ).resolves.toBe('recovery')
        await expect(
            getCcipDeliveryStatus(
                provider({
                    logs: [executionLog(2)],
                    receiptLogs: [
                        claimableLog(
                            '0x4444444444444444444444444444444444444444'
                        ),
                    ],
                }),
                {
                    direction: 'base-to-subtensor',
                    messageId,
                    fromBlock: 10,
                }
            )
        ).resolves.toBe('success')
    })
    it('reports recovery when the gateway emits NotDelivered without Claimable', async () => {
        await expect(
            getCcipDeliveryStatus(
                provider({
                    logs: [executionLog(2)],
                    receiptLogs: [notDeliveredLog()],
                }),
                {
                    direction: 'base-to-subtensor',
                    messageId,
                    fromBlock: 10,
                }
            )
        ).resolves.toBe('recovery')
        await expect(
            getCcipDeliveryStatus(
                provider({
                    logs: [executionLog(2)],
                    receiptLogs: [
                        notDeliveredLog(
                            '0x4444444444444444444444444444444444444444'
                        ),
                    ],
                }),
                {
                    direction: 'base-to-subtensor',
                    messageId,
                    fromBlock: 10,
                }
            )
        ).resolves.toBe('success')
    })
    it('does not report success when recovery evidence cannot be read', async () => {
        await expect(
            getCcipDeliveryStatus(
                provider({
                    logs: [executionLog(2)],
                    receiptAvailable: false,
                }),
                {
                    direction: 'base-to-subtensor',
                    messageId,
                    fromBlock: 10,
                }
            )
        ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    })
    it('rejects invalid directions, message IDs, and block numbers', async () => {
        const destinationProvider = provider()
        await expect(
            getCcipDeliveryStatus(destinationProvider, {
                direction: 'invalid' as 'base-to-subtensor',
                messageId,
                fromBlock: 0,
            })
        ).rejects.toMatchObject({ code: 'INVALID_TRANSACTION_PLAN' })
        await expect(
            getCcipDeliveryStatus(destinationProvider, {
                direction: 'base-to-subtensor',
                messageId: '0x1234',
                fromBlock: 0,
            })
        ).rejects.toMatchObject({ code: 'INVALID_BYTES32' })
        await expect(
            getCcipDeliveryStatus(destinationProvider, {
                direction: 'base-to-subtensor',
                messageId,
                fromBlock: Number.MAX_SAFE_INTEGER + 1,
            })
        ).rejects.toMatchObject({ code: 'INVALID_TRANSACTION_PLAN' })
    })
})
