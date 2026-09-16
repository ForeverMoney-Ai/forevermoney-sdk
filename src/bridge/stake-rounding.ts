import { EVM_WEI_PER_RAO } from '../chains/deployment.js'
import { assertWholeRao } from '../core/amounts.js'
import { ForeverMoneyError } from '../core/errors.js'
import {
    assertBoolean,
    assertNonNegativeAmount,
    assertPositiveAmount,
    normalizeBytes32,
} from '../core/validation.js'
import type { StakePull } from './plans.js'

export interface StakePosition {
    readonly hotkey: string
    readonly stakeRao: bigint
}
export interface StakeRoundingOptions {
    readonly enabled: boolean
    /** Current source balances, including any partner fee headroom. */
    readonly positions: readonly StakePosition[]
    /** Minimum positive remainder to leave on any source. Defaults to zero. */
    readonly minStakeRao?: bigint
}
export interface StakeRoundingResult {
    readonly requestedAmountWei: bigint
    readonly amountWei: bigint
    readonly minAmountOutWei: bigint
    readonly pulls: readonly StakePull[]
    /** False when approval is still required; prepare again after approval. */
    readonly simulationComplete: boolean
}
export interface EstimateRoundedStakeRequest<T> {
    readonly amountWei: bigint
    readonly minAmountOutWei: bigint
    readonly pulls: readonly StakePull[]
    readonly positions: readonly StakePosition[]
    readonly minStakeRao?: bigint
    /** Defaults to true. False estimates the exact input once, without adjustments. */
    readonly adjustRounding?: boolean
    readonly partnerFeeBps?: number
    readonly isActive?: () => boolean
    readonly quoteAndEstimate: (
        amountWei: bigint,
        pulls: readonly StakePull[],
        minAmountOutWei: bigint
    ) => Promise<T>
}
export type RoundedStakeEstimate<T> = T & {
    readonly amountWei: bigint
    readonly minAmountOutWei: bigint
    readonly pulls: readonly StakePull[]
}

function invalid(message: string): never {
    throw new ForeverMoneyError('INVALID_TRANSACTION_PLAN', message)
}

/** Small explicit output tolerance for stake transfer/deposit dust. Never returns zero. */
export function stakedMinimumOutput(
    amountWei: bigint,
    sourceCount = 1
): bigint {
    assertWholeRao(amountWei)
    if (!Number.isInteger(sourceCount) || sourceCount < 1 || sourceCount > 16)
        invalid('Source count must be between 1 and 16.')
    const rao = amountWei / EVM_WEI_PER_RAO
    const dust = 2n * BigInt(sourceCount) + 2n
    return (rao > dust ? rao - dust : rao) * EVM_WEI_PER_RAO
}

/** Supports raw RPC, ethers and viem nested errors. Ignores unrelated revert data. */
export function strandedStakeSource(error: unknown): string | null {
    const queue: unknown[] = [error]
    const seen = new Set<object>()
    while (queue.length && seen.size < 20) {
        const entry = queue.shift()
        if (
            typeof entry === 'string' &&
            /^0x5408a598[0-9a-f]{128}$/i.test(entry)
        )
            return `0x${entry.slice(10, 74)}`.toLowerCase()
        if (entry && typeof entry === 'object' && !seen.has(entry)) {
            seen.add(entry)
            for (const key of [
                'data',
                'error',
                'info',
                'cause',
                'details',
                'rpcData',
            ]) {
                const nested = (entry as Record<string, unknown>)[key]
                if (nested != null) queue.push(nested)
            }
        }
    }
    return null
}

/** SDK-owned, read-only candidate search. Never lowers minAmountOutWei or broadcasts.
 * At most eight reductions of one alpha base unit; only StrandedStake triggers retries.
 * quoteAndEstimate must quote and simulate the exact candidate, and must never sign/send.
 */
export async function estimateRoundedStake<T>({
    amountWei,
    minAmountOutWei,
    pulls,
    positions,
    minStakeRao = 0n,
    adjustRounding = true,
    partnerFeeBps = 0,
    quoteAndEstimate,
    isActive = () => true,
}: EstimateRoundedStakeRequest<T>): Promise<RoundedStakeEstimate<T>> {
    assertWholeRao(amountWei)
    assertPositiveAmount(minAmountOutWei, 'Minimum output')
    if (minAmountOutWei > amountWei)
        invalid('Minimum output cannot exceed input.')
    assertBoolean(adjustRounding, 'adjustRounding')
    assertNonNegativeAmount(minStakeRao, 'Minimum remaining stake')
    if (
        !Number.isInteger(partnerFeeBps) ||
        partnerFeeBps < 0 ||
        partnerFeeBps > 10000
    )
        invalid('Invalid partner fee basis points.')
    if (!Array.isArray(pulls) || pulls.length < 1 || pulls.length > 16)
        invalid('Provide between 1 and 16 stake pulls.')
    const keys = new Set<string>()
    const originalPulls = pulls.map((pull) => {
        const hotkey = normalizeBytes32(pull.hotkey, 'Validator').toLowerCase()
        if (keys.has(hotkey)) invalid('Duplicate stake source.')
        keys.add(hotkey)
        assertPositiveAmount(pull.amountRao, 'Stake pull')
        return { hotkey, amountRao: pull.amountRao }
    })
    if (
        originalPulls.reduce((sum, pull) => sum + pull.amountRao, 0n) *
            EVM_WEI_PER_RAO !==
        amountWei
    )
        invalid('Stake pulls must sum to the input amount.')
    const balances = new Map<string, bigint>()
    if (!Array.isArray(positions)) invalid('Stake positions must be an array.')
    for (const position of positions) {
        const key = normalizeBytes32(position.hotkey, 'Validator').toLowerCase()
        if (balances.has(key)) invalid('Duplicate stake position.')
        assertNonNegativeAmount(position.stakeRao, 'Stake balance')
        balances.set(key, position.stakeRao)
    }
    const fits = (candidatePulls: readonly StakePull[]): boolean => {
        const total = candidatePulls.reduce(
            (sum, pull) => sum + pull.amountRao,
            0n
        )
        const cut = (total * BigInt(partnerFeeBps)) / 10000n
        const shares = candidatePulls.map((pull, index) =>
            index ? (cut * pull.amountRao) / total : 0n
        )
        shares[0] = cut - shares.reduce((sum, share) => sum + share, 0n)
        return candidatePulls.every((pull, index) => {
            const balance = balances.get(pull.hotkey)
            if (balance == null) return false
            const remainder = balance - pull.amountRao - shares[index]!
            return (
                remainder === 0n || (remainder > 0n && remainder >= minStakeRao)
            )
        })
    }
    if (!fits(originalPulls))
        invalid(
            'Stake positions cannot cover the pulls, partner fee, and minimum remainder.'
        )
    let candidate = amountWei
    let candidatePulls = originalPulls
    for (let attempt = 0; ; attempt++) {
        if (!isActive()) throw new Error('Stake quote cancelled.')
        try {
            const result = await quoteAndEstimate(
                candidate,
                candidatePulls,
                minAmountOutWei
            )
            if (!isActive()) throw new Error('Stake quote cancelled.')
            return Object.freeze({
                ...result,
                amountWei: candidate,
                pulls: Object.freeze(
                    candidatePulls.map((pull) => Object.freeze({ ...pull }))
                ),
                minAmountOutWei,
            })
        } catch (error) {
            const hotkey = strandedStakeSource(error)
            if (
                !isActive() ||
                !adjustRounding ||
                !hotkey ||
                attempt >= 8 ||
                candidate - EVM_WEI_PER_RAO < minAmountOutWei
            )
                throw error
            const index = candidatePulls.findIndex(
                (pull) => pull.hotkey === hotkey
            )
            if (index < 0 || candidatePulls[index]!.amountRao <= 1n) throw error
            const nextPulls = candidatePulls.map((pull, i) =>
                i === index ? { ...pull, amountRao: pull.amountRao - 1n } : pull
            )
            if (!fits(nextPulls)) throw error
            candidatePulls = nextPulls
            candidate -= EVM_WEI_PER_RAO
        }
    }
}
