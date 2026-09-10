import { AccountId } from '@polkadot-api/substrate-bindings'
const encodeAddress = (key: Uint8Array, prefix: number) =>
    AccountId(prefix).dec(key)
import { decodeFunctionData, parseAbi, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
    ALPHA_GATEWAY_ABI,
    ERC20_ABI,
    SPOKE_GATEWAY_ABI,
    STAKING_ABI,
} from '../abis/index.js'
import {
    EVM_WEI_PER_RAO,
    ForeverMoneyError,
    MIN_LIQUID_BASE_TO_SUBTENSOR_WEI,
    buildBaseToSubtensorPlan,
    buildEvmToSubtensorPlan,
    buildSubtensorToBasePlan,
    buildSubtensorToEvmPlan,
    foreverMoneyDeployment,
} from '../index.js'
const sender = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const destination = encodeAddress(new Uint8Array(32).fill(7), 42)
const amountWei = 2500000000000000000n
describe('bridge transaction plans', () => {
    it('builds an exact-amount approval followed by Base to Subtensor bridge', () => {
        const plan = buildBaseToSubtensorPlan({
            sender,
            amountWei,
            destination,
            delivery: 'liquid',
            allowanceWei: 0n,
            exactNetworkFeeWei: 101n,
            estimatedBridgeGas: 101n,
        })
        expect(plan.action).toBe('bridge.base-to-subtensor')
        expect(plan.deploymentVersion).toBe(foreverMoneyDeployment.version)
        expect(plan.steps).toHaveLength(2)
        expect(plan.steps[0]!.kind).toBe('approval')
        expect(plan.steps[1]!.transaction.value).toBe('104')
        expect(plan.steps[1]!.transaction.gasLimit).toBe('152')
        const approval = decodeFunctionData({
            abi: parseAbi(ERC20_ABI),
            data: plan.steps[0]!.transaction.data as Hex,
        }).args!
        expect(approval[0]).toBe(foreverMoneyDeployment.base.contracts.gateway)
        expect(approval[1]).toBe(amountWei)
        const decoded = decodeFunctionData({
            abi: parseAbi(SPOKE_GATEWAY_ABI),
            data: plan.steps[1]!.transaction.data as Hex,
        }).args!
        expect(decoded[0]).toBe(
            foreverMoneyDeployment.base.contracts.wrappedTao
        )
        expect(decoded[1]).toBe(amountWei)
        expect(decoded[2]!.ss58).toBe(`0x${'07'.repeat(32)}`)
        expect(decoded[2]!.evmFallback).toBe(sender)
        expect(decoded[2]!.wantLiquid).toBe(true)
        expect(decoded[2]!.minTaoOut).toBe(amountWei)
    })
    it('omits an approval and gas limit only when the supplied state says so', () => {
        const input = {
            sender,
            amountWei,
            destination,
            delivery: 'staked' as const,
            allowanceWei: amountWei,
            exactNetworkFeeWei: 100n,
        }
        const first = buildBaseToSubtensorPlan(input)
        const second = buildBaseToSubtensorPlan(input)
        expect(first.steps).toHaveLength(1)
        expect(first.steps[0]!.transaction.gasLimit).toBeUndefined()
        expect(first.hash).toBe(second.hash)
        expect(Object.isFrozen(first.steps[0]!.transaction)).toBe(true)
    })
    it('rejects liquid delivery below the Subtensor unstaking minimum', () => {
        const build = () =>
            buildBaseToSubtensorPlan({
                sender,
                amountWei: MIN_LIQUID_BASE_TO_SUBTENSOR_WEI - 1000000000n,
                destination,
                delivery: 'liquid',
                allowanceWei: amountWei,
                exactNetworkFeeWei: 100n,
            })
        expect(build).toThrow(
            'Liquid delivery from an EVM chain to Subtensor requires at least 0.01 TAO.'
        )
        try {
            build()
        } catch (error) {
            expect(error).toBeInstanceOf(ForeverMoneyError)
            expect((error as ForeverMoneyError).code).toBe(
                'AMOUNT_BELOW_MINIMUM'
            )
            expect((error as ForeverMoneyError).details).toEqual({
                amountWei: '9999999000000000',
                minimumAmountWei: '10000000000000000',
            })
        }
    })
    it('builds canonical Robinhood bridge plans in both directions', () => {
        const toSubtensor = buildEvmToSubtensorPlan({
            evmChain: 'robinhood',
            sender,
            amountWei,
            destination,
            delivery: 'liquid',
            allowanceWei: amountWei,
            exactNetworkFeeWei: 100n,
        })
        expect(toSubtensor.action).toBe('bridge.robinhood-to-subtensor')
        expect(toSubtensor.steps[0]!.transaction).toMatchObject({
            chainId: foreverMoneyDeployment.robinhood.chainId,
            to: foreverMoneyDeployment.robinhood.contracts.gateway,
        })
        const toRobinhood = buildSubtensorToEvmPlan({
            evmChain: 'robinhood',
            sender,
            recipient,
            amountWei,
            source: 'liquid',
            exactNetworkFeeWei: 100n,
        })
        expect(toRobinhood.action).toBe('bridge.subtensor-to-robinhood')
        const bridgeOut = decodeFunctionData({
            abi: parseAbi(ALPHA_GATEWAY_ABI),
            data: toRobinhood.steps[0]!.transaction.data as Hex,
        }).args!
        expect(bridgeOut[0]).toBe(foreverMoneyDeployment.robinhood.ccipSelector)
    })
    it('accepts the minimum liquid delivery and smaller staked deliveries', () => {
        const minimumLiquid = buildBaseToSubtensorPlan({
            sender,
            amountWei: MIN_LIQUID_BASE_TO_SUBTENSOR_WEI,
            destination,
            delivery: 'liquid',
            allowanceWei: amountWei,
            exactNetworkFeeWei: 100n,
        })
        const smallStaked = buildBaseToSubtensorPlan({
            sender,
            amountWei: 1000000000n,
            destination,
            delivery: 'staked',
            allowanceWei: amountWei,
            exactNetworkFeeWei: 100n,
        })
        expect(minimumLiquid.steps).toHaveLength(1)
        expect(smallStaked.steps).toHaveLength(1)
    })
    it('builds the liquid Subtensor to Base value from amount plus buffered fee', () => {
        const plan = buildSubtensorToBasePlan({
            sender,
            recipient,
            amountWei,
            source: 'liquid',
            exactNetworkFeeWei: 100n,
            estimatedBridgeGas: 100n,
        })
        expect(plan.steps).toHaveLength(1)
        expect(plan.steps[0]!.transaction.value).toBe(
            (amountWei + 102n).toString()
        )
        const decoded = decodeFunctionData({
            abi: parseAbi(ALPHA_GATEWAY_ABI),
            data: plan.steps[0]!.transaction.data as Hex,
        }).args!
        expect(decoded[0]).toBe(foreverMoneyDeployment.base.ccipSelector)
        expect(decoded[2]).toBe(recipient)
        expect(decoded[3]).toBe(amountWei)
        expect(decoded[4]).toBe(0n)
        expect(decoded[5]).toBe(amountWei)
    })
    it('builds a staking precompile approval in RAO for staked TAO', () => {
        const netuid = 7n
        const plan = buildSubtensorToBasePlan({
            sender,
            recipient,
            amountWei,
            source: 'staked',
            netuid,
            stakingAllowanceRao: 0n,
            exactNetworkFeeWei: 100n,
        })
        expect(plan.steps).toHaveLength(2)
        const approval = decodeFunctionData({
            abi: parseAbi(STAKING_ABI),
            data: plan.steps[0]!.transaction.data as Hex,
        }).args!
        expect(approval[0]).toBe(
            foreverMoneyDeployment.subtensor.contracts.gateway
        )
        expect(approval[1]).toBe(netuid)
        expect(approval[2]).toBe(amountWei / EVM_WEI_PER_RAO)
        expect(plan.steps[1]!.transaction.value).toBe('102')
        const bridge = decodeFunctionData({
            abi: parseAbi(ALPHA_GATEWAY_ABI),
            data: plan.steps[1]!.transaction.data as Hex,
        }).args!
        expect(bridge[5]).toBe(amountWei)
    })
    it('fails closed on ambiguous or invalid bridge inputs', () => {
        expect(() =>
            buildSubtensorToBasePlan({
                sender,
                recipient,
                amountWei,
                source: 'staked',
                netuid: 1n,
                exactNetworkFeeWei: 1n,
            })
        ).toThrow('staking allowance is required')
        expect(() =>
            buildSubtensorToBasePlan({
                sender,
                recipient,
                amountWei: amountWei + 1n,
                source: 'liquid',
                exactNetworkFeeWei: 1n,
            })
        ).toThrow('whole RAO')
        expect(() =>
            buildBaseToSubtensorPlan({
                sender,
                amountWei,
                destination: encodeAddress(new Uint8Array(32).fill(7), 0),
                delivery: 'liquid',
                allowanceWei: 0n,
                exactNetworkFeeWei: 1n,
            })
        ).toThrow('prefix 42')
        expect(() =>
            buildBaseToSubtensorPlan({
                sender,
                amountWei,
                destination,
                delivery: 'invalid' as 'liquid',
                allowanceWei: amountWei,
                exactNetworkFeeWei: 1n,
            })
        ).toThrow('Delivery must be')
        expect(() =>
            buildSubtensorToBasePlan({
                sender,
                recipient,
                amountWei,
                source: 'invalid' as 'liquid',
                exactNetworkFeeWei: 1n,
            })
        ).toThrow('Source must be')
    })
})
