import { describe, expect, it, vi } from 'vitest'
import { decodeFunctionData, parseAbi, type PublicClient } from 'viem'
import { foreverMoneyAbis } from '../abis/index.js'
import { EVM_WEI_PER_RAO } from '../chains/deployment.js'
import { prepareSubtensorToEvm } from './plans.js'
import { stakedMinimumOutput } from './stake-rounding.js'

const hotkey = `0x${'12'.repeat(32)}`
const amountRao = 1_092_281_993n
const amountWei = amountRao * EVM_WEI_PER_RAO
const minAmountOutWei = stakedMinimumOutput(amountWei)
const input = {
    evmChain: 'base' as const,
    asset: 'sn80' as const,
    source: 'staked' as const,
    sender: '0x1111111111111111111111111111111111111111',
    recipient: '0x2222222222222222222222222222222222222222',
    amountWei,
    minAmountOutWei,
    stakePulls: [{ hotkey, amountRao }],
    stakeRounding: {
        enabled: true,
        positions: [{ hotkey, stakeRao: amountRao }],
    },
}
const revert = {
    cause: { data: `0x5408a598${hotkey.slice(2)}${'0'.repeat(63)}1` },
}
const abi = parseAbi(foreverMoneyAbis.alphaGateway)
function provider(allowance = amountRao) {
    const readContract = vi.fn(
        async ({ functionName }: { functionName: string }) =>
            functionName === 'allowance' ? allowance : 700n
    )
    const estimateGas = vi.fn(async ({ data }: { data: `0x${string}` }) => {
        const decoded = decodeFunctionData({ abi, data })
        if (decoded.functionName !== 'bridgeOutFromValidators')
            throw new Error('Unexpected method')
        expect(decoded.args[5]).toBe(minAmountOutWei)
        if (decoded.args[4][0]!.alphaRao === amountRao) throw revert
        return 674840n
    })
    return { readContract, estimateGas }
}

describe('rounding-aware preparation', () => {
    it('recomputes partner fees and preserves their calldata when adjusting', async () => {
        const readContract = vi.fn(
            async ({
                functionName,
                args,
            }: {
                functionName: string
                args?: readonly unknown[]
            }) => {
                if (functionName === 'allowance') return amountRao * 2n
                if (functionName === 'maxIntegratorFeeBps') return 100n
                if (functionName === 'quoteBridgeOutWithFee')
                    return [700n, 0n, (args![5] as bigint) / 100n, args![3]]
                throw new Error('Unexpected read')
            }
        )
        const estimateGas = vi.fn(async ({ data }: { data: `0x${string}` }) => {
            const decoded = decodeFunctionData({ abi, data })
            if (decoded.functionName !== 'bridgeOutFromValidatorsWithFee')
                throw new Error('Unexpected method')
            expect(decoded.args[5]).toBe(minAmountOutWei)
            expect(decoded.args[6].bps).toBe(100)
            if (decoded.args[4][0]!.alphaRao === amountRao) throw revert
            return 100n
        })
        const result = await prepareSubtensorToEvm(
            { readContract, estimateGas } as unknown as PublicClient,
            {
                ...input,
                partnerFee: {
                    recipient: '0x3333333333333333333333333333333333333333',
                    bps: 100,
                },
                stakeRounding: {
                    enabled: true,
                    positions: [{ hotkey, stakeRao: amountRao * 2n }],
                },
            }
        )
        expect(result.partnerFeeWei).toBe(
            ((amountRao - 1n) / 100n) * EVM_WEI_PER_RAO
        )
        expect(result.plan.steps[0]!.transaction.data).toBe(
            estimateGas.mock.calls[1]![0].data
        )
    })

    it('requotes a reduced input and builds exactly the successfully estimated transaction', async () => {
        const mocks = provider()
        const result = await prepareSubtensorToEvm(
            mocks as unknown as PublicClient,
            input
        )
        expect(result.stakeRounding).toMatchObject({
            requestedAmountWei: amountWei,
            amountWei: amountWei - EVM_WEI_PER_RAO,
            minAmountOutWei,
            simulationComplete: true,
        })
        const transaction = result.plan.steps[0]!.transaction
        expect(transaction.data).toBe(mocks.estimateGas.mock.calls[1]![0].data)
        expect(
            mocks.readContract.mock.calls.filter(
                ([request]) => request.functionName === 'quoteBridgeOut'
            )
        ).toHaveLength(2)
        expect(result.exactNetworkFeeWei).toBe(700n)
    })
    it.each([false, { enabled: false, positions: [] }] as const)(
        'leaves exact input unchanged when disabled (%j)',
        async (stakeRounding) => {
            const mocks = provider()
            await expect(
                prepareSubtensorToEvm(mocks as unknown as PublicClient, {
                    ...input,
                    stakeRounding,
                })
            ).rejects.toEqual(revert)
            expect(mocks.estimateGas).toHaveBeenCalledTimes(1)
        }
    )
    it('does not claim simulation success before allowance exists', async () => {
        const mocks = provider(0n)
        const result = await prepareSubtensorToEvm(
            mocks as unknown as PublicClient,
            input
        )
        expect(result.stakeRounding).toMatchObject({
            amountWei,
            simulationComplete: false,
        })
        expect(result.plan.steps[0]!.kind).toBe('approval')
        expect(mocks.estimateGas).not.toHaveBeenCalled()
    })
    it('requires explicit minimum-output tolerance to reduce input', async () => {
        const mocks = provider()
        mocks.estimateGas.mockRejectedValue(revert)
        await expect(
            prepareSubtensorToEvm(mocks as unknown as PublicClient, {
                ...input,
                minAmountOutWei: amountWei,
            })
        ).rejects.toEqual(revert)
        expect(mocks.estimateGas).toHaveBeenCalledTimes(1)
    })
})
