import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import fixtures from '../fixtures/berachain-receipts.json'
import {
    berachainRoyaltyAssets,
    bridgeMessageIdFromReceipt,
    buildBaseToBerachainPlan,
    buildBerachainToBasePlan,
    destinationChainId,
    evmChainFromBridgeDirection,
    feeWithBuffer,
    foreverMoneyDeployment,
    ForeverMoneyError,
    isBerachainDirection,
    isEvmToSubtensorDirection,
    sourceChainId,
} from '../index.js'
import { prepareBaseToBerachain, prepareBerachainToBase } from './royalty.js'

// The wallet that ran the verified mainnet round trips (29 Oct 2026).
const wallet = '0xcb72f64e5fE988EA83a4768D29A0efcF39C0EB75'
const amountWei = 100_000_000_000_000_000n
const { base, berachain } = foreverMoneyDeployment

describe('Berachain royalty bridge plans', () => {
    it('encodes Base to Berachain exactly like the verified mainnet send', () => {
        const plan = buildBaseToBerachainPlan({
            asset: 'sailr',
            sender: wallet,
            recipient: wallet,
            amountWei,
            allowanceWei: amountWei,
            exactNetworkFeeWei: 1n,
        })
        expect(plan.action).toBe('bridge.base-to-berachain')
        expect(plan.steps).toHaveLength(1)
        const tx = plan.steps[0]!.transaction
        expect(tx.chainId).toBe(base.chainId)
        expect(tx.to).toBe(base.contracts.ccipRouter)
        expect(tx.data).toBe(fixtures.baseToBerachain.input)
    })

    it('encodes Berachain to Base exactly like the verified mainnet wrapAndSend', () => {
        const plan = buildBerachainToBasePlan({
            asset: 'sailr',
            sender: wallet,
            recipient: wallet,
            amountWei,
            allowanceWei: amountWei,
            exactNetworkFeeWei: 10n,
        })
        expect(plan.action).toBe('bridge.berachain-to-base')
        const tx = plan.steps[0]!.transaction
        expect(tx.chainId).toBe(berachain.chainId)
        expect(tx.to).toBe(berachain.contracts.royaltyGateway)
        expect(tx.data).toBe(fixtures.berachainToBase.input)
        expect(tx.value).toBe(feeWithBuffer(10n).toString())
    })

    it('approves the router on Base and the gateway on Berachain when needed', () => {
        const toBerachain = buildBaseToBerachainPlan({
            asset: 'computer',
            sender: wallet,
            recipient: wallet,
            amountWei,
            allowanceWei: 0n,
            exactNetworkFeeWei: 1n,
        })
        expect(toBerachain.steps.map((step) => step.kind)).toEqual([
            'approval',
            'transaction',
        ])
        expect(toBerachain.steps[0]!.transaction.to).toBe(
            berachainRoyaltyAssets.computer.wrapped
        )
        const toBase = buildBerachainToBasePlan({
            asset: 'computer',
            sender: wallet,
            recipient: wallet,
            amountWei,
            allowanceWei: amountWei - 1n,
            exactNetworkFeeWei: 1n,
        })
        expect(toBase.steps[0]!.transaction.to).toBe(
            berachainRoyaltyAssets.computer.underlying
        )
    })

    it('rejects unknown assets, zero amounts and bad recipients', () => {
        const input = {
            asset: 'sailr' as const,
            sender: wallet,
            recipient: wallet,
            amountWei,
            allowanceWei: 0n,
            exactNetworkFeeWei: 1n,
        }
        expect(() =>
            buildBaseToBerachainPlan({ ...input, asset: 'nope' as 'sailr' })
        ).toThrow(ForeverMoneyError)
        expect(() =>
            buildBaseToBerachainPlan({ ...input, amountWei: 0n })
        ).toThrow(/greater than zero/)
        expect(() =>
            buildBerachainToBasePlan({ ...input, recipient: '0x1234' })
        ).toThrow(ForeverMoneyError)
    })
})

describe('Berachain royalty bridge preparation', () => {
    const limiter = (tokens: bigint) => ({
        tokens,
        lastUpdated: 0,
        isEnabled: true,
        capacity: tokens,
        rate: 1n,
    })

    it('quotes the router fee and estimates gas once approved', async () => {
        const readContract = vi.fn(async ({ functionName }) =>
            functionName === 'allowance'
                ? amountWei
                : functionName === 'getFee'
                  ? 1_000n
                  : limiter(amountWei)
        )
        const estimateGas = vi.fn(async () => 300_000n)
        const prepared = await prepareBaseToBerachain(
            { readContract, estimateGas } as unknown as PublicClient,
            { asset: 'sailr', sender: wallet, recipient: wallet, amountWei }
        )
        expect(prepared.exactNetworkFeeWei).toBe(1_000n)
        expect(prepared.transactionValueWei).toBe(feeWithBuffer(1_000n))
        expect(estimateGas).toHaveBeenCalledOnce()
        expect(prepared.plan.steps).toHaveLength(1)
        expect(readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                address: berachainRoyaltyAssets.sailr.pool,
                args: [berachain.ccipSelector],
            })
        )
    })

    it('quotes through the gateway and skips gas estimation before approval', async () => {
        const readContract = vi.fn(async ({ functionName }) =>
            functionName === 'allowance'
                ? 0n
                : functionName === 'quoteWrapAndSend'
                  ? 2_000n
                  : limiter(amountWei)
        )
        const estimateGas = vi.fn()
        const prepared = await prepareBerachainToBase(
            { readContract, estimateGas } as unknown as PublicClient,
            { asset: 'computer', sender: wallet, recipient: wallet, amountWei }
        )
        expect(prepared.exactNetworkFeeWei).toBe(2_000n)
        expect(estimateGas).not.toHaveBeenCalled()
        expect(prepared.plan.steps.map((step) => step.kind)).toEqual([
            'approval',
            'transaction',
        ])
    })

    it('rejects amounts above the pool rate limit', async () => {
        const readContract = vi.fn(async ({ functionName }) =>
            functionName === 'getCurrentOutboundRateLimiterState'
                ? limiter(amountWei - 1n)
                : 0n
        )
        await expect(
            prepareBerachainToBase(
                { readContract } as unknown as PublicClient,
                { asset: 'sailr', sender: wallet, recipient: wallet, amountWei }
            )
        ).rejects.toMatchObject({ code: 'AMOUNT_ABOVE_RATE_LIMIT' })
    })
})

describe('Berachain lane tracking', () => {
    it('reads message IDs from the verified mainnet receipts', () => {
        expect(
            bridgeMessageIdFromReceipt(
                'base-to-berachain',
                fixtures.baseToBerachain
            )
        ).toBe(
            '0xbf0f2d35043c5583f1c920c47bc8e7f13d29011628b0e53dd77959d965187d7a'
        )
        expect(
            bridgeMessageIdFromReceipt(
                'berachain-to-base',
                fixtures.berachainToBase
            )
        ).toBe(
            '0x7b72ab1175e2262725ae4f14e96047983fa032f4bcb0c1e80e149ca5cc372997'
        )
        // A send to the other chain is not this lane's message.
        expect(
            bridgeMessageIdFromReceipt(
                'berachain-to-base',
                fixtures.baseToBerachain
            )
        ).toBeNull()
    })

    it('maps both directions to Base and Berachain only', () => {
        expect(isBerachainDirection('base-to-berachain')).toBe(true)
        expect(isEvmToSubtensorDirection('base-to-berachain')).toBe(false)
        expect(sourceChainId('base-to-berachain')).toBe(base.chainId)
        expect(destinationChainId('base-to-berachain')).toBe(berachain.chainId)
        expect(sourceChainId('berachain-to-base')).toBe(berachain.chainId)
        expect(destinationChainId('berachain-to-base')).toBe(base.chainId)
        expect(() => evmChainFromBridgeDirection('berachain-to-base')).toThrow(
            ForeverMoneyError
        )
    })
})
