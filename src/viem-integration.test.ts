import { describe, expect, it, vi } from 'vitest'
import {
    encodeErrorResult,
    encodeFunctionResult,
    parseAbi,
    toHex,
    type Hex,
} from 'viem'
import {
    ALPHA_GATEWAY_ABI,
    CCIP_EXECUTION_ABI,
    SPOKE_GATEWAY_ABI,
} from './abis/index.js'
import {
    createForeverMoneyClient,
    getBridgeSourceStatus,
    getCcipDeliveryCheckpoint,
    getCcipDeliveryStatus,
    type LegacyRpcProvider,
    foreverMoneyDeployment,
    http,
    type RpcRequest,
    type RpcTransport,
} from './index.js'
import { eventLog } from './test-utils.js'

const sender = '0x1111111111111111111111111111111111111111'
const hash: Hex = `0x${'12'.repeat(32)}`
const messageId: Hex = `0x${'34'.repeat(32)}`
const { base, subtensor } = foreverMoneyDeployment
const unused: RpcTransport = {
    request: async () => {
        throw new Error('Unexpected transport call')
    },
}
const transport = (
    chainId: number,
    handler: (request: RpcRequest) => unknown
): RpcTransport => ({
    request: vi.fn(async (request) =>
        request.method === 'eth_chainId' ? toHex(chainId) : handler(request)
    ),
})

function rpcLog(address: string, encoded: ReturnType<typeof eventLog>) {
    return {
        address,
        ...encoded,
        blockNumber: '0x10',
        blockHash: hash,
        transactionHash: hash,
        transactionIndex: '0x0',
        logIndex: '0x0',
        removed: false,
    }
}
function rpcReceipt(logs: ReturnType<typeof rpcLog>[], status = '0x1') {
    return {
        transactionHash: hash,
        transactionIndex: '0x0',
        blockHash: hash,
        blockNumber: '0x10',
        from: sender,
        to: base.contracts.legacyGateway,
        cumulativeGasUsed: '0x100',
        gasUsed: '0x100',
        effectiveGasPrice: '0x1',
        contractAddress: null,
        logs,
        logsBloom: `0x${'00'.repeat(256)}`,
        status,
        type: '0x2',
    }
}

describe('viem RPC integration boundaries', () => {
    it('decodes raw source receipts and rejects invalid status values', async () => {
        const log = rpcLog(
            base.contracts.legacyGateway,
            eventLog(parseAbi(SPOKE_GATEWAY_ABI), 'BridgedToFinney', [
                base.contracts.wrappedTao,
                sender,
                messageId,
                1n,
                messageId,
            ])
        )
        for (const [status, expected] of [
            ['0x1', 'confirmed'],
            ['0x0', 'failed'],
            ['0x2', 'invalid'],
        ] as const) {
            const client = createForeverMoneyClient({
                transports: {
                    base: transport(8453, () => rpcReceipt([log], status)),
                    subtensor: unused,
                },
            })
            const result = client.bridge.getSourceStatus({
                direction: 'base-to-subtensor',
                transactionHash: hash,
            })
            if (expected === 'invalid')
                await expect(result).rejects.toMatchObject({
                    code: 'INVALID_PROVIDER_RESPONSE',
                })
            else
                await expect(result).resolves.toMatchObject({
                    status: expected,
                    messageId: expected === 'confirmed' ? messageId : null,
                })
        }
    })

    it('encodes authorized CCIP filters and decodes recovery through real viem formatters', async () => {
        const execution = rpcLog(
            subtensor.contracts.ccipOffRampFromBase,
            eventLog(parseAbi(CCIP_EXECUTION_ABI), 'ExecutionStateChanged', [
                base.ccipSelector,
                1n,
                messageId,
                hash,
                2,
                '0x',
                100n,
            ])
        )
        const claimable = rpcLog(
            subtensor.contracts.legacyGateway,
            eventLog(parseAbi(ALPHA_GATEWAY_ABI), 'Claimable', [
                subtensor.contracts.wrappedTao,
                sender,
                1n,
                0n,
            ])
        )
        const destination = transport(964, (request) => {
            if (request.method === 'eth_getLogs') {
                expect(request.params).toEqual([
                    {
                        address: subtensor.contracts.ccipOffRampFromBase,
                        fromBlock: '0xa',
                        toBlock: 'latest',
                        topics: [
                            execution.topics[0],
                            toHex(base.ccipSelector, { size: 32 }),
                            null,
                            messageId,
                        ],
                    },
                ])
                return [execution]
            }
            if (request.method === 'eth_getTransactionReceipt')
                return rpcReceipt([claimable])
            throw new Error('Unexpected request')
        })
        const client = createForeverMoneyClient({
            transports: { base: unused, subtensor: destination },
        })
        await expect(
            client.bridge.getDeliveryStatus({
                direction: 'base-to-subtensor',
                messageId,
                fromBlock: 10,
            })
        ).resolves.toBe('recovery')
    })

    it('preserves gas-simulation reverts from EIP-1193 transports', async () => {
        const source = transport(964, (request) => {
            if (request.method === 'eth_call')
                return encodeFunctionResult({
                    abi: parseAbi(ALPHA_GATEWAY_ABI),
                    functionName: 'quoteBridgeOut',
                    result: 100n,
                })
            throw Object.assign(new Error('execution reverted'), {
                code: 3,
                data: '0x',
            })
        })
        const client = createForeverMoneyClient({
            transports: { base: unused, subtensor: source },
        })
        await expect(
            client.bridge.prepareSubtensorToBase({
                sender,
                recipient: sender,
                amountWei: 1_000_000_000_000_000_000n,
                source: 'liquid',
            })
        ).rejects.toMatchObject({ code: 'SIMULATION_REVERTED' })
    })

    it('preserves revert classification through the SDK HTTP transport', async () => {
        const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
            const request = JSON.parse(String(init?.body)) as {
                id: number
                method: string
            }
            const data = encodeErrorResult({
                abi: parseAbi(['error Error(string)']),
                errorName: 'Error',
                args: ['LaneNotAllowed'],
            })
            return new Response(
                JSON.stringify({
                    jsonrpc: '2.0',
                    id: request.id,
                    ...(request.method === 'eth_chainId'
                        ? { result: '0x3c4' }
                        : {
                              error: {
                                  code: 3,
                                  message: 'execution reverted',
                                  data,
                              },
                          }),
                }),
                { status: 200 }
            )
        })
        const client = createForeverMoneyClient({
            transports: {
                base: unused,
                subtensor: http('https://rpc.example', { fetch: fetcher }),
            },
        })
        await expect(
            client.bridge.prepareSubtensorToBase({
                sender,
                recipient: sender,
                amountWei: 1_000_000_000_000_000_000n,
                source: 'liquid',
            })
        ).rejects.toMatchObject({ code: 'SIMULATION_REVERTED' })
        expect(fetcher).toHaveBeenCalledTimes(2)
    })

    it('rechecks chain IDs after a transport changes networks', async () => {
        let chain = 8453
        const source: RpcTransport = { request: async () => toHex(chain) }
        const client = createForeverMoneyClient({
            transports: { base: source, subtensor: transport(964, () => null) },
        })
        await client.verifyConnections()
        chain = 1
        await expect(client.verifyConnections()).rejects.toMatchObject({
            code: 'CHAIN_MISMATCH',
        })
    })

    it('maps network failures without exposing RPC URLs or retrying', async () => {
        const source = transport(964, () => {
            throw new Error('https://secret-rpc.example/private-key')
        })
        const client = createForeverMoneyClient({
            transports: { base: unused, subtensor: source },
        })
        const result = client.bridge.prepareSubtensorToBase({
            sender,
            recipient: sender,
            amountWei: 1_000_000_000_000_000_000n,
            source: 'liquid',
        })
        await expect(result).rejects.toMatchObject({ code: 'RPC_ERROR' })
        await expect(result).rejects.not.toThrow('secret-rpc')
        expect(source.request).toHaveBeenCalledTimes(2)
    })
})

// Mirrors ethers' public send(method, params) API, including its bound `this`.
function legacyProvider(
    chainId: number,
    handler: (request: RpcRequest) => unknown
) {
    return {
        chainId,
        handler,
        async send(method: string, params: unknown[]): Promise<unknown> {
            if (method === 'eth_chainId') return toHex(this.chainId)
            return this.handler({ method, params })
        },
    }
}

describe('legacy JSON-RPC provider compatibility', () => {
    it.each([
        ['base-to-subtensor', 964],
        ['robinhood-to-subtensor', 964],
        ['subtensor-to-base', 8453],
        ['subtensor-to-robinhood', 4663],
    ] as const)(
        'reads a checkpoint through a legacy provider for %s',
        async (direction, chainId) => {
            const provider = legacyProvider(chainId, ({ method }) => {
                expect(method).toBe('eth_blockNumber')
                return '0x2a'
            })
            await expect(
                getCcipDeliveryCheckpoint(provider, direction)
            ).resolves.toEqual({
                direction,
                destinationChainId: chainId,
                fromBlock: 42,
            })
            provider.chainId = 1
            await expect(
                getCcipDeliveryCheckpoint(provider, direction)
            ).rejects.toMatchObject({ code: 'CHAIN_MISMATCH' })
        }
    )

    it.each(['pending', 'failed', 'confirmed'] as const)(
        'reads %s source status through a legacy provider',
        async (status) => {
            const log = rpcLog(
                base.contracts.legacyGateway,
                eventLog(parseAbi(SPOKE_GATEWAY_ABI), 'BridgedToFinney', [
                    base.contracts.wrappedTao,
                    sender,
                    messageId,
                    1n,
                    messageId,
                ])
            )
            const provider = legacyProvider(8453, ({ method, params }) => {
                expect(method).toBe('eth_getTransactionReceipt')
                expect(params).toEqual([hash])
                return status === 'pending'
                    ? null
                    : rpcReceipt([log], status === 'failed' ? '0x0' : '0x1')
            })
            await expect(
                getBridgeSourceStatus(provider, {
                    direction: 'base-to-subtensor',
                    transactionHash: hash,
                })
            ).resolves.toMatchObject({
                status,
                messageId: status === 'confirmed' ? messageId : null,
            })
        }
    )

    it.each(['waiting', 'failure', 'success', 'recovery'] as const)(
        'reads %s delivery status through a legacy provider',
        async (status) => {
            const execution = rpcLog(
                subtensor.contracts.ccipOffRampFromBase,
                eventLog(
                    parseAbi(CCIP_EXECUTION_ABI),
                    'ExecutionStateChanged',
                    [
                        base.ccipSelector,
                        1n,
                        messageId,
                        hash,
                        status === 'failure' ? 3 : 2,
                        '0x',
                        100n,
                    ]
                )
            )
            const claimable = rpcLog(
                subtensor.contracts.legacyGateway,
                eventLog(parseAbi(ALPHA_GATEWAY_ABI), 'Claimable', [
                    subtensor.contracts.wrappedTao,
                    sender,
                    1n,
                    0n,
                ])
            )
            const provider = legacyProvider(964, ({ method, params }) => {
                if (method === 'eth_getLogs') {
                    expect(params).toEqual([
                        {
                            address: subtensor.contracts.ccipOffRampFromBase,
                            fromBlock: '0xa',
                            toBlock: 'latest',
                            topics: [
                                execution.topics[0],
                                toHex(base.ccipSelector, { size: 32 }),
                                null,
                                messageId,
                            ],
                        },
                    ])
                    return status === 'waiting' ? [] : [execution]
                }
                if (method === 'eth_getTransactionReceipt')
                    return rpcReceipt(status === 'recovery' ? [claimable] : [])
                throw new Error('Unexpected request')
            })
            await expect(
                getCcipDeliveryStatus(provider, {
                    direction: 'base-to-subtensor',
                    messageId,
                    fromBlock: 10,
                })
            ).resolves.toBe(status)
        }
    )

    it('rejects invalid providers with a stable SDK error', async () => {
        await expect(
            getCcipDeliveryCheckpoint(
                {} as LegacyRpcProvider,
                'base-to-subtensor'
            )
        ).rejects.toMatchObject({ code: 'MISSING_TRANSPORT' })
    })

    it('rejects missing recovery receipts rather than reporting success', async () => {
        const execution = rpcLog(
            subtensor.contracts.ccipOffRampFromBase,
            eventLog(parseAbi(CCIP_EXECUTION_ABI), 'ExecutionStateChanged', [
                base.ccipSelector,
                1n,
                messageId,
                hash,
                2,
                '0x',
                100n,
            ])
        )
        const provider = legacyProvider(964, ({ method }) =>
            method === 'eth_getLogs' ? [execution] : null
        )
        await expect(
            getCcipDeliveryStatus(provider, {
                direction: 'base-to-subtensor',
                messageId,
                fromBlock: 10,
            })
        ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' })
    })
})
