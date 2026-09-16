import { decodeFunctionData, parseAbi, type Hex, type PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
    ALPHA_GATEWAY_ABI,
    ERC20_ABI,
    SPOKE_GATEWAY_ABI,
    STAKING_ABI,
} from '../abis/index.js'
import {
    EVM_WEI_PER_RAO,
    MAX_PARTNER_FEE_BPS,
    buildBaseToSubtensorPlan,
    buildEvmToSubtensorPlan,
    buildSubtensorToBasePlan,
    evmToMirrorSS58,
    foreverMoneyDeployment,
    partnerFeeCut,
    partnerFeeTaoTopUp,
    type PartnerFee,
} from '../index.js'
import { prepareEvmToSubtensor, prepareSubtensorToEvm } from './plans.js'

const { base, robinhood, subtensor } = foreverMoneyDeployment
const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const partner = '0x3333333333333333333333333333333333333333'
const hundred = 100n * 10n ** 18n
const partnerFee: PartnerFee = { recipient: partner, bps: 100 } // 1%
const spoke = parseAbi(SPOKE_GATEWAY_ABI)
const alpha = parseAbi(ALPHA_GATEWAY_ABI)
const erc20 = parseAbi(ERC20_ABI)
const staking = parseAbi(STAKING_ABI)
const decode = (
    abi: typeof spoke | typeof alpha | typeof erc20 | typeof staking,
    data: string
) => decodeFunctionData({ abi, data: data as Hex })

describe('partner fee math', () => {
    it('matches the gateway formulas', () => {
        expect(partnerFeeCut(hundred, 100)).toBe(10n ** 18n)
        expect(partnerFeeCut(10n ** 18n, 1)).toBe(10n ** 14n)
        expect(partnerFeeCut(999n, 100)).toBe(9n) // rounds down like Solidity
        expect(partnerFeeTaoTopUp(hundred, 100)).toBe(10n ** 18n)
        // 1 bps of 1 TAO is 0.0001 TAO = exactly 100000 RAO
        expect(partnerFeeTaoTopUp(10n ** 18n, 1)).toBe(10n ** 14n)
        // rounds UP to a whole RAO
        expect(partnerFeeTaoTopUp(EVM_WEI_PER_RAO + 1n, 1)).toBe(
            EVM_WEI_PER_RAO
        )
        expect(partnerFeeTaoTopUp(EVM_WEI_PER_RAO, 1)).toBe(EVM_WEI_PER_RAO)
        expect(partnerFeeTaoTopUp(hundred, 0)).toBe(0n)
    })
})

describe('EVM to Subtensor with a partner fee', () => {
    it('approves amount plus cut and calls bridgeToFinneyWithFee; the full amount crosses', () => {
        const plan = buildBaseToSubtensorPlan({
            sender,
            amountWei: hundred,
            destination: evmToMirrorSS58(recipient),
            delivery: 'staked',
            allowanceWei: hundred, // enough for the amount, not the cut
            exactNetworkFeeWei: 100n,
            partnerFee,
        })
        expect(plan.steps).toHaveLength(2)
        const approval = decode(erc20, plan.steps[0]!.transaction.data)
        expect(approval.args).toEqual([
            base.contracts.gateway,
            hundred + 10n ** 18n,
        ])
        const bridge = decode(spoke, plan.steps[1]!.transaction.data)
        expect(bridge.functionName).toBe('bridgeToFinneyWithFee')
        expect(bridge.args?.[0]).toBe(base.contracts.wrappedTao)
        expect(bridge.args?.[1]).toBe(hundred)
        expect(bridge.args?.[3]).toBe(0n) // default destination gas
        expect(bridge.args?.[4]).toEqual({ recipient: partner, bps: 100 })
        expect(plan.steps[1]!.transaction.value).toBe('102') // native fee unchanged
        expect(plan.summary).toContain('Partner fee: 1000000000000000000 wei')
    })

    it('skips the approval once the allowance covers amount plus cut', () => {
        const plan = buildBaseToSubtensorPlan({
            sender,
            amountWei: hundred,
            destination: evmToMirrorSS58(recipient),
            delivery: 'liquid',
            allowanceWei: hundred + 10n ** 18n,
            exactNetworkFeeWei: 100n,
            partnerFee,
        })
        expect(plan.steps).toHaveLength(1)
    })

    it('works for SN80 and on Robinhood', () => {
        const sn80 = buildBaseToSubtensorPlan({
            asset: 'sn80',
            sender,
            amountWei: hundred,
            destination: evmToMirrorSS58(recipient),
            delivery: 'staked',
            allowanceWei: 0n,
            exactNetworkFeeWei: 100n,
            partnerFee,
        })
        expect(sn80.steps[0]!.transaction.to).toBe(base.contracts.wrappedSn80)
        expect(decode(spoke, sn80.steps[1]!.transaction.data).args?.[0]).toBe(
            base.contracts.wrappedSn80
        )
        const rh = buildEvmToSubtensorPlan({
            evmChain: 'robinhood',
            sender,
            amountWei: hundred,
            destination: evmToMirrorSS58(recipient),
            delivery: 'staked',
            allowanceWei: 0n,
            exactNetworkFeeWei: 100n,
            partnerFee,
        })
        expect(rh.steps[1]!.transaction.to).toBe(robinhood.contracts.gateway)
        expect(decode(spoke, rh.steps[1]!.transaction.data).functionName).toBe(
            'bridgeToFinneyWithFee'
        )
    })

    it('produces the zero-fee plan when bps is 0 or the fee is omitted', () => {
        const input = {
            sender,
            amountWei: hundred,
            destination: evmToMirrorSS58(recipient),
            delivery: 'staked' as const,
            allowanceWei: 0n,
            exactNetworkFeeWei: 100n,
        }
        const plain = buildBaseToSubtensorPlan(input)
        const zero = buildBaseToSubtensorPlan({
            ...input,
            partnerFee: { recipient: partner, bps: 0 },
        })
        expect(zero).toEqual(plain)
        expect(
            decode(spoke, plain.steps[1]!.transaction.data).functionName
        ).toBe('bridgeToFinney')
    })

    it('quotes with the fee, enforces the gateway cap, and estimates gas with the WithFee calldata', async () => {
        const calls: string[] = []
        const readContract = vi.fn(async ({ functionName, args }) => {
            calls.push(functionName)
            switch (functionName) {
                case 'allowance':
                    return hundred + 10n ** 18n
                case 'maxIntegratorFeeBps':
                    return 100
                case 'quoteBridgeToFinneyWithFee':
                    expect(args[4]).toEqual({ recipient: partner, bps: 100 })
                    return [500n, 10n ** 18n, hundred]
                default:
                    throw new Error(`unexpected ${functionName}`)
            }
        })
        const estimateGas = vi.fn(async ({ data }) => {
            expect(decode(spoke, data).functionName).toBe(
                'bridgeToFinneyWithFee'
            )
            return 100n
        })
        const result = await prepareEvmToSubtensor(
            { readContract, estimateGas } as unknown as PublicClient,
            {
                evmChain: 'base',
                sender,
                amountWei: hundred,
                destination: evmToMirrorSS58(recipient),
                delivery: 'staked',
                partnerFee,
            }
        )
        expect(calls).not.toContain('quoteBridgeToFinney')
        expect(result.exactNetworkFeeWei).toBe(500n)
        expect(result.partnerFeeWei).toBe(10n ** 18n)
        expect(result.plan.steps).toHaveLength(1)
        expect(estimateGas).toHaveBeenCalledOnce()

        const capped = vi.fn(async ({ functionName }) =>
            functionName === 'maxIntegratorFeeBps' ? 50 : hundred
        )
        await expect(
            prepareEvmToSubtensor(
                {
                    readContract: capped,
                    estimateGas,
                } as unknown as PublicClient,
                {
                    evmChain: 'base',
                    sender,
                    amountWei: hundred,
                    destination: evmToMirrorSS58(recipient),
                    delivery: 'staked',
                    partnerFee,
                }
            )
        ).rejects.toMatchObject({
            code: 'INVALID_PARTNER_FEE',
            details: { bps: 100, maxBps: 50 },
        })
    })
})

describe('Subtensor to EVM with a partner fee', () => {
    it('liquid source: adds the whole-RAO TAO top-up to value and calls bridgeOutWithFee', () => {
        const plan = buildSubtensorToBasePlan({
            sender,
            recipient,
            amountWei: hundred,
            source: 'liquid',
            exactNetworkFeeWei: 100n,
            partnerFee,
        })
        expect(plan.steps).toHaveLength(1)
        const call = decode(alpha, plan.steps[0]!.transaction.data)
        expect(call.functionName).toBe('bridgeOutWithFee')
        expect(call.args?.[3]).toBe(hundred) // taoAmount unchanged
        expect(call.args?.[5]).toBe(hundred) // minTokenOut bounds what crosses
        expect(call.args?.[6]).toEqual({ recipient: partner, bps: 100 })
        expect(plan.steps[0]!.transaction.value).toBe(
            (hundred + 10n ** 18n + 102n).toString()
        )
    })

    it('staked source: approves alpha plus the cut and passes the fee', () => {
        const amountRao = hundred / EVM_WEI_PER_RAO
        const plan = buildSubtensorToBasePlan({
            sender,
            recipient,
            amountWei: hundred,
            source: 'staked',
            netuid: 0n,
            stakingAllowanceRao: amountRao, // covers the amount but not the cut
            exactNetworkFeeWei: 100n,
            partnerFee,
        })
        expect(plan.steps).toHaveLength(2)
        const approval = decode(staking, plan.steps[0]!.transaction.data)
        expect(approval.args).toEqual([
            subtensor.contracts.gateway,
            0n,
            amountRao + amountRao / 100n,
        ])
        const call = decode(alpha, plan.steps[1]!.transaction.data)
        expect(call.functionName).toBe('bridgeOutWithFee')
        expect(call.args?.[4]).toBe(amountRao)
        expect(plan.steps[1]!.transaction.value).toBe('102') // no TAO top-up for staked
    })

    it('quotes with the fee and only estimates gas once the allowance covers the cut', async () => {
        const amountRao = hundred / EVM_WEI_PER_RAO
        const make = (allowance: bigint) =>
            vi.fn(async ({ functionName, args }) => {
                switch (functionName) {
                    case 'maxIntegratorFeeBps':
                        return 100
                    case 'quoteBridgeOutWithFee':
                        expect(args[4]).toEqual({
                            recipient: partner,
                            bps: 100,
                        })
                        return [700n, 10n ** 18n, hundred]
                    case 'allowance':
                        return allowance
                    default:
                        throw new Error(`unexpected ${functionName}`)
                }
            })
        const estimateGas = vi.fn(async ({ data, value }) => {
            expect(decode(alpha, data).functionName).toBe('bridgeOutWithFee')
            expect(value).toBe(714n) // 700 + 2% buffer
            return 100n
        })
        const short = await prepareSubtensorToEvm(
            {
                readContract: make(amountRao),
                estimateGas,
            } as unknown as PublicClient,
            {
                evmChain: 'base',
                sender,
                recipient,
                amountWei: hundred,
                source: 'staked',
                netuid: 0n,
                partnerFee,
            }
        )
        expect(estimateGas).not.toHaveBeenCalled()
        expect(short.plan.steps).toHaveLength(2)
        expect(short.exactNetworkFeeWei).toBe(700n)
        expect(short.partnerFeeWei).toBe(10n ** 18n) // 1% of the alpha, as wei

        const covered = await prepareSubtensorToEvm(
            {
                readContract: make(amountRao + amountRao / 100n),
                estimateGas,
            } as unknown as PublicClient,
            {
                evmChain: 'base',
                sender,
                recipient,
                amountWei: hundred,
                source: 'staked',
                netuid: 0n,
                partnerFee,
            }
        )
        expect(estimateGas).toHaveBeenCalledOnce()
        expect(covered.plan.steps).toHaveLength(1)

        const liquid = await prepareSubtensorToEvm(
            {
                readContract: make(0n),
                estimateGas: vi.fn(async () => 100n),
            } as unknown as PublicClient,
            {
                evmChain: 'base',
                sender,
                recipient,
                amountWei: hundred,
                source: 'liquid',
                partnerFee,
            }
        )
        expect(liquid.partnerFeeWei).toBe(10n ** 18n)
        expect(liquid.transactionValueWei).toBe(hundred + 10n ** 18n + 714n)
    })
})

describe('partner fee validation', () => {
    const input = {
        sender,
        amountWei: hundred,
        destination: evmToMirrorSS58(recipient),
        delivery: 'staked' as const,
        allowanceWei: 0n,
        exactNetworkFeeWei: 100n,
    }
    it.each([
        [{ recipient: partner, bps: -1 }, 'between 0 and'],
        [{ recipient: partner, bps: 1.5 }, 'between 0 and'],
        [{ recipient: partner, bps: MAX_PARTNER_FEE_BPS + 1 }, 'between 0 and'],
        [
            {
                recipient: '0x0000000000000000000000000000000000000000',
                bps: 10,
            },
            'non-zero EVM address',
        ],
        [{ recipient: base.contracts.gateway, bps: 10 }, 'the gateway'],
    ])('rejects %j before building a plan', (fee, message) => {
        expect(() =>
            buildBaseToSubtensorPlan({ ...input, partnerFee: fee })
        ).toThrow(message)
        try {
            buildBaseToSubtensorPlan({ ...input, partnerFee: fee })
        } catch (error) {
            expect(['INVALID_PARTNER_FEE', 'INVALID_ADDRESS']).toContain(
                (error as { code: string }).code
            )
        }
    })
    it('rejects the Subtensor gateway as recipient on the hub side and never hits RPC', async () => {
        const readContract = vi.fn()
        await expect(
            prepareSubtensorToEvm({ readContract } as unknown as PublicClient, {
                evmChain: 'base',
                sender,
                recipient,
                amountWei: hundred,
                source: 'liquid',
                partnerFee: { recipient: subtensor.contracts.gateway, bps: 10 },
            })
        ).rejects.toMatchObject({ code: 'INVALID_PARTNER_FEE' })
        expect(readContract).not.toHaveBeenCalled()
    })
    it('rejects an invalid recipient address', () => {
        expect(() =>
            buildBaseToSubtensorPlan({
                ...input,
                partnerFee: { recipient: '0x12', bps: 10 },
            })
        ).toThrow()
    })
})
