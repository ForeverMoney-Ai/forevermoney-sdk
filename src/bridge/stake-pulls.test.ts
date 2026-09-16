import { decodeFunctionData, parseAbi, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { ALPHA_GATEWAY_ABI, STAKING_ABI } from '../abis/index.js'
import {
    EVM_WEI_PER_RAO,
    MAX_STAKE_PULLS,
    buildSubtensorToBasePlan,
    buildSubtensorToEvmPlan,
    foreverMoneyDeployment,
    type StakePull,
} from '../index.js'
import { prepareSubtensorToEvm } from './plans.js'

const { base, subtensor } = foreverMoneyDeployment
const alpha = parseAbi(ALPHA_GATEWAY_ABI)
const staking = parseAbi(STAKING_ABI)
const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const partner = '0x3333333333333333333333333333333333333333'
const hotkeyA = `0x${'aa'.repeat(32)}`
const hotkeyB = `0x${'bb'.repeat(32)}`
const amountRao = 140_000_000_000n
const amountWei = amountRao * EVM_WEI_PER_RAO
const pulls: StakePull[] = [
    { hotkey: hotkeyA, amountRao: 100_000_000_000n },
    { hotkey: hotkeyB, amountRao: 40_000_000_000n },
]
const decode = (data: string) =>
    decodeFunctionData({ abi: alpha, data: data as Hex })

describe('staked bridges that pull from several validators', () => {
    it.each([false, true])(
        'passes explicit minimum output with partner fee=%s',
        (withFee) => {
            const minimum = amountWei - 4n * EVM_WEI_PER_RAO
            for (const stakePulls of [undefined, pulls]) {
                const plan = buildSubtensorToBasePlan({
                    sender,
                    recipient,
                    amountWei,
                    minAmountOutWei: minimum,
                    source: 'staked',
                    netuid: 80n,
                    asset: 'sn80',
                    ...(stakePulls ? { stakePulls } : {}),
                    ...(withFee
                        ? { partnerFee: { recipient: partner, bps: 100 } }
                        : {}),
                    stakingAllowanceRao: amountRao * 2n,
                    exactNetworkFeeWei: 100n,
                })
                const call = decode(plan.steps[0]!.transaction.data)
                expect(call.args?.[5]).toBe(minimum)
            }
        }
    )

    it.each([0n, -1n, amountWei + 1n, 1 as unknown as bigint])(
        'rejects invalid minimum %s before RPC calls',
        async (minAmountOutWei) => {
            const readContract = vi.fn()
            await expect(
                prepareSubtensorToEvm(
                    { readContract } as unknown as PublicClient,
                    {
                        evmChain: 'base',
                        sender,
                        recipient,
                        amountWei,
                        source: 'staked',
                        netuid: 0n,
                        minAmountOutWei,
                    }
                )
            ).rejects.toThrow()
            expect(readContract).not.toHaveBeenCalled()
        }
    )
    it('encodes bridgeOutFromValidators with the pulls and a 1:1 minimum output', () => {
        const plan = buildSubtensorToBasePlan({
            sender,
            recipient,
            amountWei,
            source: 'staked',
            netuid: 80n,
            asset: 'sn80',
            stakePulls: pulls,
            stakingAllowanceRao: 0n,
            exactNetworkFeeWei: 100n,
        })
        expect(plan.steps).toHaveLength(2)
        const approval = decodeFunctionData({
            abi: staking,
            data: plan.steps[0]!.transaction.data as Hex,
        })
        expect(approval.args).toEqual([
            subtensor.contracts.gateway,
            80n,
            amountRao,
        ])
        const call = decode(plan.steps[1]!.transaction.data)
        expect(call.functionName).toBe('bridgeOutFromValidators')
        expect(call.args).toEqual([
            base.ccipSelector,
            subtensor.contracts.wrappedSn80,
            recipient,
            0n,
            [
                { validator: hotkeyA, alphaRao: 100_000_000_000n },
                { validator: hotkeyB, alphaRao: 40_000_000_000n },
            ],
            amountWei,
        ])
        expect(plan.steps[1]!.transaction.value).toBe('102')
    })

    it('uses the WithFee variant and budgets the approval for the cut on top', () => {
        const plan = buildSubtensorToBasePlan({
            sender,
            recipient,
            amountWei,
            source: 'staked',
            netuid: 0n,
            stakePulls: pulls,
            stakingAllowanceRao: amountRao,
            exactNetworkFeeWei: 100n,
            partnerFee: { recipient: partner, bps: 100 },
        })
        expect(plan.steps).toHaveLength(2)
        const approval = decodeFunctionData({
            abi: staking,
            data: plan.steps[0]!.transaction.data as Hex,
        })
        expect(approval.args?.[2]).toBe(amountRao + amountRao / 100n)
        const call = decode(plan.steps[1]!.transaction.data)
        expect(call.functionName).toBe('bridgeOutFromValidatorsWithFee')
        expect(call.args?.[6]).toEqual({ recipient: partner, bps: 100 })
    })

    it('keeps the single-validator bridgeOut path when no pulls are given', () => {
        const plan = buildSubtensorToBasePlan({
            sender,
            recipient,
            amountWei,
            source: 'staked',
            netuid: 0n,
            stakingAllowanceRao: amountRao,
            exactNetworkFeeWei: 100n,
        })
        expect(decode(plan.steps[0]!.transaction.data).functionName).toBe(
            'bridgeOut'
        )
    })

    it.each([
        [[], 'Between 1 and'],
        [
            Array.from({ length: MAX_STAKE_PULLS + 1 }, (_, i) => ({
                hotkey: `0x${(i + 1).toString(16).padStart(64, '0')}`,
                amountRao: 1n,
            })),
            'Between 1 and',
        ],
        [
            [{ hotkey: hotkeyA, amountRao: amountRao - 1n }],
            'sum to the bridged amount',
        ],
        [
            [
                { hotkey: hotkeyA, amountRao: 70_000_000_000n },
                {
                    hotkey: hotkeyA.toUpperCase().replace('0X', '0x'),
                    amountRao: 70_000_000_000n,
                },
            ],
            'repeat a hotkey',
        ],
        [
            [
                { hotkey: hotkeyA, amountRao: amountRao },
                { hotkey: hotkeyB, amountRao: 0n },
            ],
            'positive amount',
        ],
        [[{ hotkey: `0x${'0'.repeat(64)}`, amountRao }], 'must not be zero'],
    ])('rejects an invalid pull list (%#)', (bad, message) => {
        expect(() =>
            buildSubtensorToBasePlan({
                sender,
                recipient,
                amountWei,
                source: 'staked',
                netuid: 0n,
                stakePulls: bad as StakePull[],
                stakingAllowanceRao: amountRao,
                exactNetworkFeeWei: 100n,
            })
        ).toThrow(message)
    })

    it('rejects pulls on a liquid source', () => {
        expect(() =>
            buildSubtensorToEvmPlan({
                evmChain: 'base',
                sender,
                recipient,
                amountWei,
                source: 'liquid',
                stakePulls: pulls,
                exactNetworkFeeWei: 100n,
            })
        ).toThrow('only valid for a staked source')
    })

    it('estimates gas with the multi-validator calldata once the allowance covers the pulls', async () => {
        const readContract = vi.fn(async ({ functionName }) =>
            functionName === 'allowance' ? amountRao : 700n
        )
        const estimateGas = vi.fn(async ({ data }) => {
            expect(decode(data).functionName).toBe('bridgeOutFromValidators')
            expect(decode(data).args?.[5]).toBe(
                amountWei - 4n * EVM_WEI_PER_RAO
            )
            return 100n
        })
        const result = await prepareSubtensorToEvm(
            { readContract, estimateGas } as unknown as PublicClient,
            {
                evmChain: 'base',
                sender,
                recipient,
                amountWei,
                source: 'staked',
                netuid: 0n,
                stakePulls: pulls,
                minAmountOutWei: amountWei - 4n * EVM_WEI_PER_RAO,
            }
        )
        expect(estimateGas).toHaveBeenCalledOnce()
        expect(result.plan.steps).toHaveLength(1)
        expect(
            decode(result.plan.steps[0]!.transaction.data).functionName
        ).toBe('bridgeOutFromValidators')
        expect(decode(result.plan.steps[0]!.transaction.data).args?.[5]).toBe(
            amountWei - 4n * EVM_WEI_PER_RAO
        )
    })
})
