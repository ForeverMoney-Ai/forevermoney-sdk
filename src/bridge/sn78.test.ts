import { decodeFunctionData, parseAbi, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
    ALPHA_GATEWAY_ABI,
    ERC20_ABI,
    SPOKE_GATEWAY_ABI,
    STAKING_ABI,
} from '../abis/index.js'
import {
    EVM_TO_SUBTENSOR_DESTINATION_GAS_LIMIT,
    EVM_WEI_PER_RAO,
    SN78_NETUID,
    bridgeMessageIdFromReceipt,
    buildBaseToSubtensorPlan,
    buildEvmToSubtensorPlan,
    buildSubtensorToBasePlan,
    buildSubtensorToEvmPlan,
    evmToMirrorSS58,
    foreverMoneyDeployment,
    type EvmToSubtensorRequest,
    type SubtensorToEvmRequest,
} from '../index.js'
import { eventLog } from '../test-utils.js'
import { prepareEvmToSubtensor, prepareSubtensorToEvm } from './plans.js'

const { base, robinhood, subtensor } = foreverMoneyDeployment
const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const amountWei = 100n * 10n ** 18n
const amountRao = amountWei / EVM_WEI_PER_RAO
const toFinney: EvmToSubtensorRequest = {
    asset: 'sn78',
    evmChain: 'base',
    sender,
    amountWei,
    destination: evmToMirrorSS58(recipient),
    delivery: 'staked',
}
const toBase: SubtensorToEvmRequest = {
    asset: 'sn78',
    evmChain: 'base',
    sender,
    recipient,
    amountWei,
    source: 'staked',
}

describe('SN78 bridging between Base and Subtensor', () => {
    it('approves and bridges the full Base SN78 amount to subnet stake', () => {
        const plan = buildBaseToSubtensorPlan({
            ...toFinney,
            allowanceWei: 0n,
            exactNetworkFeeWei: 100n,
        })
        const [approval, transfer] = plan.steps
        expect(approval!.transaction.to).toBe(base.contracts.wrappedSn78)
        expect(
            decodeFunctionData({
                abi: parseAbi(ERC20_ABI),
                data: approval!.transaction.data as Hex,
            }).args
        ).toEqual([base.contracts.gateway, amountWei])
        const call = decodeFunctionData({
            abi: parseAbi(SPOKE_GATEWAY_ABI),
            data: transfer!.transaction.data as Hex,
        })
        expect(call.functionName).toBe('bridgeToFinney')
        expect(call.args).toEqual([
            base.contracts.wrappedSn78,
            amountWei,
            {
                ss58: expect.any(String),
                evmFallback: sender,
                wantLiquid: false,
                minTaoOut: amountWei,
            },
            EVM_TO_SUBTENSOR_DESTINATION_GAS_LIMIT,
        ])
        expect(transfer!.transaction.to).toBe(base.contracts.gateway)
        expect(transfer!.transaction.value).toBe('102')
        expect(transfer!.label).toContain('SN78')
    })

    it('approves subnet 78 stake in RAO and bridges all of it with zero partner fee', () => {
        const plan = buildSubtensorToBasePlan({
            ...toBase,
            stakingAllowanceRao: 0n,
            exactNetworkFeeWei: 100n,
        })
        const [approval, transfer] = plan.steps
        expect(approval!.transaction.to).toBe(
            subtensor.contracts.stakingPrecompile
        )
        expect(
            decodeFunctionData({
                abi: parseAbi(STAKING_ABI),
                data: approval!.transaction.data as Hex,
            }).args
        ).toEqual([subtensor.contracts.gateway, SN78_NETUID, amountRao])
        const call = decodeFunctionData({
            abi: parseAbi(ALPHA_GATEWAY_ABI),
            data: transfer!.transaction.data as Hex,
        })
        expect(call.functionName).toBe('bridgeOut')
        expect(call.args).toEqual([
            base.ccipSelector,
            subtensor.contracts.wrappedSn78,
            recipient,
            0n,
            amountRao,
            amountWei,
        ])
        expect(transfer!.transaction.value).toBe('102')
        expect(transfer!.transaction.to).toBe(subtensor.contracts.gateway)
    })

    it('accepts existing approvals and amounts below the liquid TAO minimum', () => {
        expect(
            buildSubtensorToBasePlan({
                ...toBase,
                amountWei: EVM_WEI_PER_RAO,
                netuid: 78n,
                stakingAllowanceRao: 1n,
                exactNetworkFeeWei: 100n,
            }).steps
        ).toHaveLength(1)
        expect(
            buildBaseToSubtensorPlan({
                ...toFinney,
                amountWei: EVM_WEI_PER_RAO,
                allowanceWei: EVM_WEI_PER_RAO,
                exactNetworkFeeWei: 100n,
            }).steps
        ).toHaveLength(1)
        expect(() =>
            buildSubtensorToBasePlan({
                ...toBase,
                amountWei: 1n,
                stakingAllowanceRao: amountRao,
                exactNetworkFeeWei: 100n,
            })
        ).toThrow('whole RAO')
    })

    it('builds Robinhood SN78 plans with its token, gateway and selector', () => {
        const inbound = buildEvmToSubtensorPlan({
            ...toFinney,
            evmChain: 'robinhood',
            allowanceWei: 0n,
            exactNetworkFeeWei: 100n,
        })
        expect(inbound.action).toBe('bridge.robinhood-to-subtensor')
        expect(inbound.steps[0]!.transaction.to).toBe(
            robinhood.contracts.wrappedSn78
        )
        expect(inbound.steps[1]!.transaction.to).toBe(
            robinhood.contracts.gateway
        )
        const inboundCall = decodeFunctionData({
            abi: parseAbi(SPOKE_GATEWAY_ABI),
            data: inbound.steps[1]!.transaction.data as Hex,
        })
        expect(inboundCall.args?.[0]).toBe(robinhood.contracts.wrappedSn78)

        const outbound = buildSubtensorToEvmPlan({
            ...toBase,
            evmChain: 'robinhood',
            stakingAllowanceRao: amountRao,
            exactNetworkFeeWei: 100n,
        })
        expect(outbound.action).toBe('bridge.subtensor-to-robinhood')
        const outboundCall = decodeFunctionData({
            abi: parseAbi(ALPHA_GATEWAY_ABI),
            data: outbound.steps[0]!.transaction.data as Hex,
        })
        expect(outboundCall.args?.[0]).toBe(robinhood.ccipSelector)
        expect(outboundCall.args?.[1]).toBe(subtensor.contracts.wrappedSn78)
    })

    it('quotes the Base SN78 token and estimates only after its approval exists', async () => {
        const destinationGasLimit = 4_200_000n
        const readContract = vi.fn(async ({ functionName }) =>
            functionName === 'allowance' ? amountWei : 100n
        )
        const estimateGas = vi.fn(async () => 100n)
        const result = await prepareEvmToSubtensor(
            { readContract, estimateGas } as unknown as PublicClient,
            { ...toFinney, destinationGasLimit }
        )
        expect(readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                address: base.contracts.wrappedSn78,
                functionName: 'allowance',
                args: [sender, base.contracts.gateway],
            })
        )
        expect(readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                address: base.contracts.gateway,
                functionName: 'quoteBridgeToFinney',
                args: [
                    base.contracts.wrappedSn78,
                    amountWei,
                    expect.objectContaining({
                        wantLiquid: false,
                        minTaoOut: amountWei,
                    }),
                    destinationGasLimit,
                ],
            })
        )
        expect(estimateGas).toHaveBeenCalledOnce()
        expect(result.plan.steps).toHaveLength(1)
        expect(result.plan.steps[0]!.transaction.gasLimit).toBe('150')
        expect(result.transactionValueWei).toBe(102n)
        const bridge = decodeFunctionData({
            abi: parseAbi(SPOKE_GATEWAY_ABI),
            data: result.plan.steps[0]!.transaction.data as Hex,
        })
        expect(bridge.args?.[3]).toBe(destinationGasLimit)
    })

    it('rejects non-positive destination gas overrides before RPC calls', async () => {
        const readContract = vi.fn()
        await expect(
            prepareEvmToSubtensor({ readContract } as unknown as PublicClient, {
                ...toFinney,
                destinationGasLimit: 0n,
            })
        ).rejects.toMatchObject({ code: 'INVALID_TRANSACTION_PLAN' })
        expect(readContract).not.toHaveBeenCalled()
        expect(() =>
            buildBaseToSubtensorPlan({
                ...toFinney,
                destinationGasLimit: -1n,
                allowanceWei: amountWei,
                exactNetworkFeeWei: 100n,
            })
        ).toThrow('positive bigint')
    })

    it('quotes Finney SN78 and checks allowance for subnet 78 before preparing approval', async () => {
        const readContract = vi.fn(async ({ functionName }) =>
            functionName === 'allowance' ? 0n : 100n
        )
        const estimateGas = vi.fn()
        const result = await prepareSubtensorToEvm(
            { readContract, estimateGas } as unknown as PublicClient,
            toBase
        )
        expect(readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                address: subtensor.contracts.gateway,
                functionName: 'quoteBridgeOut',
                args: [
                    base.ccipSelector,
                    subtensor.contracts.wrappedSn78,
                    recipient,
                    amountWei,
                ],
            })
        )
        expect(readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                address: subtensor.contracts.stakingPrecompile,
                functionName: 'allowance',
                args: [sender, subtensor.contracts.gateway, 78n],
            })
        )
        expect(estimateGas).not.toHaveBeenCalled()
        expect(result.plan.steps).toHaveLength(2)
        expect(result.transactionValueWei).toBe(102n)
    })

    it('rejects unsupported liquid conversion, routes, assets, and wrong subnets before RPC', async () => {
        const readContract = vi.fn(),
            estimateGas = vi.fn()
        const provider = {
            readContract,
            estimateGas,
        } as unknown as PublicClient
        for (const input of [
            { ...toFinney, delivery: 'liquid' as const },
            { ...toFinney, asset: 'sn81' } as unknown as EvmToSubtensorRequest,
        ]) {
            await expect(
                prepareEvmToSubtensor(provider, input)
            ).rejects.toMatchObject({ code: 'INVALID_TRANSACTION_PLAN' })
        }
        for (const input of [
            { ...toBase, source: 'liquid' as const },
            { ...toBase, netuid: 0n },
        ]) {
            await expect(
                prepareSubtensorToEvm(provider, input)
            ).rejects.toMatchObject({ code: 'INVALID_TRANSACTION_PLAN' })
        }
        expect(readContract).not.toHaveBeenCalled()
        expect(estimateGas).not.toHaveBeenCalled()
        expect(() =>
            buildSubtensorToBasePlan({
                ...toBase,
                netuid: 0n,
                stakingAllowanceRao: amountRao,
                exactNetworkFeeWei: 100n,
            })
        ).toThrow('netuid 78')
        expect(() =>
            buildBaseToSubtensorPlan({
                ...toFinney,
                delivery: 'liquid',
                allowanceWei: amountWei,
                exactNetworkFeeWei: 100n,
            })
        ).toThrow('liquid TAO conversion')
    })

    it('tracks SN78 message IDs in both directions using the existing receipt API', () => {
        const messageId = `0x${'44'.repeat(32)}`
        const inbound = eventLog(
            parseAbi(SPOKE_GATEWAY_ABI),
            'BridgedToFinney',
            [
                base.contracts.wrappedSn78,
                sender,
                `0x${'55'.repeat(32)}`,
                amountWei,
                messageId,
            ]
        )
        expect(
            bridgeMessageIdFromReceipt('base-to-subtensor', {
                logs: [{ address: base.contracts.gateway, ...inbound }],
            })
        ).toBe(messageId)
        const outbound = eventLog(parseAbi(ALPHA_GATEWAY_ABI), 'BridgedOut', [
            base.ccipSelector,
            subtensor.contracts.wrappedSn78,
            sender,
            recipient,
            amountWei,
            messageId,
        ])
        expect(
            bridgeMessageIdFromReceipt('subtensor-to-base', {
                logs: [{ address: subtensor.contracts.gateway, ...outbound }],
            })
        ).toBe(messageId)
    })
})
