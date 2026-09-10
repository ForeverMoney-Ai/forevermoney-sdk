import { AccountId } from '@polkadot-api/substrate-bindings'
const encodeAddress = (key: Uint8Array, prefix: number) =>
    AccountId(prefix).dec(key)
import {
    decodeFunctionData,
    encodeFunctionResult,
    parseAbi,
    type Hex,
} from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
    ALPHA_GATEWAY_ABI,
    ERC20_ABI,
    SPOKE_GATEWAY_ABI,
    STAKING_ABI,
} from './abis/index.js'
import {
    createForeverMoneyClient,
    foreverMoneyDeployment,
    type RpcRequest,
    type RpcTransport,
} from './index.js'
const erc20 = parseAbi(ERC20_ABI)
const spoke = parseAbi(SPOKE_GATEWAY_ABI)
const alpha = parseAbi(ALPHA_GATEWAY_ABI)
const staking = parseAbi(STAKING_ABI)
const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const destination = encodeAddress(new Uint8Array(32).fill(7), 42)
const amountWei = 1000000000000000000n
function requestTransaction(request: RpcRequest): {
    readonly to: string
    readonly data: string
} {
    if (!Array.isArray(request.params)) {
        throw new Error(`${request.method} params must be an array.`)
    }
    const transaction = request.params[0]
    if (
        typeof transaction !== 'object' ||
        transaction === null ||
        !('to' in transaction) ||
        !('data' in transaction) ||
        typeof transaction.to !== 'string' ||
        typeof transaction.data !== 'string'
    ) {
        throw new Error(`${request.method} did not include a transaction.`)
    }
    return { to: transaction.to, data: transaction.data }
}
function mockTransport(
    chainId: number,
    handler: (request: RpcRequest) => unknown
): RpcTransport {
    return {
        request: vi.fn(async (request: RpcRequest) => {
            if (request.method === 'eth_chainId') {
                return `0x${chainId.toString(16)}`
            }
            return handler(request)
        }),
    }
}
describe('ForeverMoney client contract integration', () => {
    it('captures bridge checkpoints from the verified destination transport', async () => {
        const base = mockTransport(8453, () => {
            throw new Error('Unexpected Base call.')
        })
        const subtensor = mockTransport(964, (request) => {
            if (request.method === 'eth_blockNumber') return '0x7b'
            throw new Error(`Unexpected Subtensor call: ${request.method}`)
        })
        const client = createForeverMoneyClient({
            transports: { base, subtensor },
        })
        await expect(
            client.bridge.getDeliveryCheckpoint('base-to-subtensor')
        ).resolves.toEqual({
            direction: 'base-to-subtensor',
            destinationChainId: 964,
            fromBlock: 123,
        })
    })
    it('reads bridge source status from the source transport', async () => {
        const base = mockTransport(8453, (request) => {
            if (request.method === 'eth_getTransactionReceipt') return null
            throw new Error(`Unexpected Base call: ${request.method}`)
        })
        const subtensor = mockTransport(964, () => {
            throw new Error('Unexpected Subtensor call.')
        })
        const client = createForeverMoneyClient({
            transports: { base, subtensor },
        })
        await expect(
            client.bridge.getSourceStatus({
                direction: 'base-to-subtensor',
                transactionHash: `0x${'11'.repeat(32)}`,
            })
        ).resolves.toMatchObject({
            sourceChainId: 8453,
            status: 'pending',
            messageId: null,
        })
    })
    it('reads Base allowance and quote before returning an approval-aware plan', async () => {
        const base = mockTransport(8453, (request) => {
            expect(request.method).toBe('eth_call')
            const transaction = requestTransaction(request)
            if (
                transaction.to.toLowerCase() ===
                foreverMoneyDeployment.base.contracts.wrappedTao.toLowerCase()
            ) {
                expect(
                    decodeFunctionData({
                        abi: erc20,
                        data: transaction.data as Hex,
                    }).functionName
                ).toBe('allowance')
                return encodeFunctionResult({
                    abi: erc20,
                    functionName: 'allowance',
                    result: 0n,
                })
            }
            expect(transaction.to.toLowerCase()).toBe(
                foreverMoneyDeployment.base.contracts.gateway.toLowerCase()
            )
            const quote = decodeFunctionData({
                abi: spoke,
                data: transaction.data as Hex,
            })
            expect(quote?.functionName).toBe('quoteBridgeToFinney')
            expect(quote?.args[2]!.minTaoOut).toBe(amountWei)
            return encodeFunctionResult({
                abi: spoke,
                functionName: 'quoteBridgeToFinney',
                result: 100n,
            })
        })
        const subtensor = mockTransport(964, () => {
            throw new Error('Unexpected Subtensor call.')
        })
        const client = createForeverMoneyClient({
            transports: { base, subtensor },
        })
        const prepared = await client.bridge.prepareBaseToSubtensor({
            sender,
            amountWei,
            destination,
            delivery: 'liquid',
        })
        expect(prepared.exactNetworkFeeWei).toBe(100n)
        expect(prepared.transactionValueWei).toBe(102n)
        expect(prepared.plan.steps.map(({ kind }) => kind)).toEqual([
            'approval',
            'transaction',
        ])
    })
    it('routes Robinhood preparation through its dedicated transport', async () => {
        const base = mockTransport(8453, () => {
            throw new Error('Unexpected Base call.')
        })
        const robinhood = mockTransport(4663, (request) => {
            expect(request.method).toBe('eth_call')
            const transaction = requestTransaction(request)
            if (
                transaction.to.toLowerCase() ===
                foreverMoneyDeployment.robinhood.contracts.wrappedTao.toLowerCase()
            ) {
                return encodeFunctionResult({
                    abi: erc20,
                    functionName: 'allowance',
                    result: 0n,
                })
            }
            expect(transaction.to.toLowerCase()).toBe(
                foreverMoneyDeployment.robinhood.contracts.gateway.toLowerCase()
            )
            return encodeFunctionResult({
                abi: spoke,
                functionName: 'quoteBridgeToFinney',
                result: 100n,
            })
        })
        const subtensor = mockTransport(964, () => {
            throw new Error('Unexpected Subtensor call.')
        })
        const client = createForeverMoneyClient({
            transports: { base, robinhood, subtensor },
        })
        const prepared = await client.bridge.prepareEvmToSubtensor({
            evmChain: 'robinhood',
            sender,
            amountWei,
            destination,
            delivery: 'liquid',
        })
        expect(prepared.plan.action).toBe('bridge.robinhood-to-subtensor')
        expect(prepared.plan.steps[1]!.transaction.chainId).toBe(4663)
    })
    it('prepares Subtensor to Robinhood with the canonical selector', async () => {
        const base = mockTransport(8453, () => {
            throw new Error('Unexpected Base call.')
        })
        const robinhood = mockTransport(4663, () => {
            throw new Error('Unexpected Robinhood call.')
        })
        const subtensor = mockTransport(964, (request) => {
            const transaction = requestTransaction(request)
            const call = decodeFunctionData({
                abi: alpha,
                data: transaction.data as Hex,
            })
            expect(call?.args[0]).toBe(
                foreverMoneyDeployment.robinhood.ccipSelector
            )
            if (request.method === 'eth_estimateGas') return '0xc8'
            return encodeFunctionResult({
                abi: alpha,
                functionName: 'quoteBridgeOut',
                result: 100n,
            })
        })
        const client = createForeverMoneyClient({
            transports: { base, robinhood, subtensor },
        })
        const prepared = await client.bridge.prepareSubtensorToEvm({
            evmChain: 'robinhood',
            sender,
            recipient,
            amountWei,
            source: 'liquid',
        })
        expect(prepared.plan.action).toBe('bridge.subtensor-to-robinhood')
        expect(prepared.plan.steps[0]!.transaction.chainId).toBe(964)
    })
    it('quotes and simulates a liquid Subtensor to Base bridge', async () => {
        const base = mockTransport(8453, () => {
            throw new Error('Unexpected Base call.')
        })
        const subtensor = mockTransport(964, (request) => {
            const transaction = requestTransaction(request)
            expect(transaction.to.toLowerCase()).toBe(
                foreverMoneyDeployment.subtensor.contracts.gateway.toLowerCase()
            )
            const call = decodeFunctionData({
                abi: alpha,
                data: transaction.data as Hex,
            })
            if (request.method === 'eth_estimateGas') {
                expect(call?.functionName).toBe('bridgeOut')
                expect(call?.args[5]).toBe(amountWei)
                return '0xc8'
            }
            expect(request.method).toBe('eth_call')
            expect(call?.functionName).toBe('quoteBridgeOut')
            return encodeFunctionResult({
                abi: alpha,
                functionName: 'quoteBridgeOut',
                result: 100n,
            })
        })
        const client = createForeverMoneyClient({
            transports: { base, subtensor },
        })
        const prepared = await client.bridge.prepareSubtensorToBase({
            sender,
            recipient,
            amountWei,
            source: 'liquid',
        })
        expect(prepared.plan.steps).toHaveLength(1)
        expect(prepared.plan.steps[0]!.transaction.gasLimit).toBe('300')
        expect(prepared.transactionValueWei).toBe(amountWei + 102n)
    })
    it('reads the staking precompile allowance in RAO for a staked source', async () => {
        const base = mockTransport(8453, () => {
            throw new Error('Unexpected Base call.')
        })
        const subtensor = mockTransport(964, (request) => {
            expect(request.method).toBe('eth_call')
            const transaction = requestTransaction(request)
            if (
                transaction.to.toLowerCase() ===
                foreverMoneyDeployment.subtensor.contracts.stakingPrecompile.toLowerCase()
            ) {
                expect(
                    decodeFunctionData({
                        abi: staking,
                        data: transaction.data as Hex,
                    }).functionName
                ).toBe('allowance')
                return encodeFunctionResult({
                    abi: staking,
                    functionName: 'allowance',
                    result: 0n,
                })
            }
            return encodeFunctionResult({
                abi: alpha,
                functionName: 'quoteBridgeOut',
                result: 100n,
            })
        })
        const client = createForeverMoneyClient({
            transports: { base, subtensor },
        })
        const prepared = await client.bridge.prepareSubtensorToBase({
            sender,
            recipient,
            amountWei,
            source: 'staked',
            netuid: 7n,
        })
        expect(prepared.plan.steps.map(({ kind }) => kind)).toEqual([
            'approval',
            'transaction',
        ])
        expect(prepared.transactionValueWei).toBe(102n)
    })
})
