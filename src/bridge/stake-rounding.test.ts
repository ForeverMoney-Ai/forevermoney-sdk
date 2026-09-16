import { describe, expect, it, vi } from 'vitest'
import { estimateRoundedStake, strandedStakeSource } from './stake-rounding.js'

const hotkey = `0x${'12'.repeat(32)}`
const other = `0x${'34'.repeat(32)}`
const stranded = (key = hotkey) => ({
    info: {
        error: {
            data: { data: `0x5408a598${key.slice(2)}${'0'.repeat(63)}1` },
        },
    },
})
const defaults = {
    amountWei: 1092281993000000000n,
    minAmountOutWei: 1092281989000000000n,
    pulls: [{ hotkey, amountRao: 1092281993n }],
    positions: [{ hotkey, stakeRao: 1092281993n }],
}
describe('stake rounding search', () => {
    it('decodes the SDK HTTP transport error shape', () => {
        expect(
            strandedStakeSource({
                cause: {
                    details: {
                        rpcData: `0x5408a598${hotkey.slice(2)}${'0'.repeat(63)}1`,
                    },
                },
            })
        ).toBe(hotkey)
    })

    it('rejects fee redistribution that would strand a subminimum balance on another source', async () => {
        const quoteAndEstimate = vi.fn().mockRejectedValue(stranded(other))
        await expect(
            estimateRoundedStake({
                amountWei: 200n * 1000000000n,
                minAmountOutWei: 190n * 1000000000n,
                pulls: [
                    { hotkey, amountRao: 100n },
                    { hotkey: other, amountRao: 100n },
                ],
                positions: [
                    { hotkey, stakeRao: 101n },
                    { hotkey: other, stakeRao: 100n },
                ],
                partnerFeeBps: 50,
                minStakeRao: 20n,
                quoteAndEstimate,
            })
        ).rejects.toEqual(stranded(other))
        expect(quoteAndEstimate).toHaveBeenCalledTimes(1)
    })
    it('does not return a stale candidate after cancellation during an RPC', async () => {
        let active = true
        const quoteAndEstimate = vi.fn(async () => {
            active = false
            return { gas: 1n }
        })
        await expect(
            estimateRoundedStake({
                ...defaults,
                isActive: () => active,
                quoteAndEstimate,
            })
        ).rejects.toThrow('cancelled')
        expect(quoteAndEstimate).toHaveBeenCalledTimes(1)
    })

    it('can disable rounding without a retry', async () => {
        const quoteAndEstimate = vi.fn().mockRejectedValue(stranded())
        await expect(
            estimateRoundedStake({
                ...defaults,
                adjustRounding: false,
                quoteAndEstimate,
            })
        ).rejects.toEqual(stranded())
        expect(quoteAndEstimate).toHaveBeenCalledTimes(1)
    })
    it('caps searches at eight reductions even with a large output budget', async () => {
        const quoteAndEstimate = vi.fn().mockRejectedValue(stranded())
        await expect(
            estimateRoundedStake({
                ...defaults,
                minAmountOutWei: 1n,
                quoteAndEstimate,
            })
        ).rejects.toEqual(stranded())
        expect(quoteAndEstimate).toHaveBeenCalledTimes(9)
    })
    it('validates the request before network work', async () => {
        const quoteAndEstimate = vi.fn()
        await expect(
            estimateRoundedStake({
                ...defaults,
                amountWei: defaults.amountWei + 1n,
                quoteAndEstimate,
            })
        ).rejects.toThrow()
        await expect(
            estimateRoundedStake({
                ...defaults,
                pulls: [...defaults.pulls, defaults.pulls[0]!],
                quoteAndEstimate,
            })
        ).rejects.toThrow('Duplicate')
        await expect(
            estimateRoundedStake({
                ...defaults,
                minAmountOutWei: defaults.amountWei + 1n,
                quoteAndEstimate,
            })
        ).rejects.toThrow('Minimum')
        expect(quoteAndEstimate).not.toHaveBeenCalled()
    })
    it('checks partner fee headroom on every candidate', async () => {
        const quoteAndEstimate = vi.fn()
        await expect(
            estimateRoundedStake({
                ...defaults,
                partnerFeeBps: 100,
                quoteAndEstimate,
            })
        ).rejects.toThrow('partner fee')
        expect(quoteAndEstimate).not.toHaveBeenCalled()
    })

    it('finds the one-unit adjustment without weakening minimum output', async () => {
        const quoteAndEstimate = vi
            .fn()
            .mockRejectedValueOnce(stranded())
            .mockResolvedValue({ gas: 674840n, fee: 12n })
        const result = await estimateRoundedStake({
            ...defaults,
            quoteAndEstimate,
        })
        expect(result.amountWei).toBe(1092281992000000000n)
        expect(result.pulls[0]!.amountRao).toBe(1092281992n)
        expect(quoteAndEstimate.mock.calls[1]![2]).toBe(
            defaults.minAmountOutWei
        )
        expect(defaults.pulls[0]!.amountRao).toBe(1092281993n)
    })
    it('reduces only the failing validator in a multi-source plan', async () => {
        const result = await estimateRoundedStake({
            ...defaults,
            amountWei: defaults.amountWei + 10000000000n,
            pulls: [...defaults.pulls, { hotkey: other, amountRao: 10n }],
            positions: [
                ...defaults.positions,
                { hotkey: other, stakeRao: 10n },
            ],
            quoteAndEstimate: vi
                .fn()
                .mockRejectedValueOnce(stranded(other))
                .mockResolvedValue({ gas: 1n }),
        })
        expect(result.pulls).toEqual([
            defaults.pulls[0],
            { hotkey: other, amountRao: 9n },
        ])
    })
    it('stops at the minimum output rather than expanding the budget', async () => {
        const quoteAndEstimate = vi.fn().mockRejectedValue(stranded())
        await expect(
            estimateRoundedStake({ ...defaults, quoteAndEstimate })
        ).rejects.toEqual(stranded())
        expect(quoteAndEstimate).toHaveBeenCalledTimes(5)
    })
    it('does not retry unrelated errors or leave a subminimum stake remainder', async () => {
        const quoteAndEstimate = vi
            .fn()
            .mockRejectedValue(new Error('RPC unavailable'))
        await expect(
            estimateRoundedStake({ ...defaults, quoteAndEstimate })
        ).rejects.toThrow('RPC unavailable')
        expect(quoteAndEstimate).toHaveBeenCalledTimes(1)
        quoteAndEstimate.mockClear().mockRejectedValue(stranded())
        await expect(
            estimateRoundedStake({
                ...defaults,
                minStakeRao: 20n,
                quoteAndEstimate,
            })
        ).rejects.toEqual(stranded())
        expect(quoteAndEstimate).toHaveBeenCalledTimes(1)
    })
    it('stops cancelled work before another RPC', async () => {
        const quoteAndEstimate = vi.fn().mockRejectedValue(stranded())
        await expect(
            estimateRoundedStake({
                ...defaults,
                isActive: () => false,
                quoteAndEstimate,
            })
        ).rejects.toThrow('cancelled')
        expect(quoteAndEstimate).not.toHaveBeenCalled()
    })
})
