import { describe, expect, it } from 'vitest'
import baseline from './fixtures/pre-viem-plans.json'
import {
    buildEvmToSubtensorPlan,
    buildSubtensorToEvmPlan,
    evmToMirrorSS58,
    type BuildEvmToSubtensorPlanRequest,
    type BuildSubtensorToEvmPlanRequest,
} from './index.js'

// Captured from the original ethers / Polkadot.js implementation before migration.
const fixtures = JSON.parse(JSON.stringify(baseline), (_, value: unknown) => {
    if (
        typeof value === 'object' &&
        value !== null &&
        '$bigint' in value &&
        typeof value.$bigint === 'string'
    )
        return BigInt(value.$bigint)
    return value
}) as {
    mirror: string
    cases: (
        | {
              method: 'buildEvmToSubtensorPlan'
              input: BuildEvmToSubtensorPlanRequest
              plan: unknown
          }
        | {
              method: 'buildSubtensorToEvmPlan'
              input: BuildSubtensorToEvmPlanRequest
              plan: unknown
          }
    )[]
}

describe('dependency migration compatibility', () => {
    it('preserves the Subtensor EVM mirror address', () => {
        expect(
            evmToMirrorSS58('0x1111111111111111111111111111111111111111')
        ).toBe(fixtures.mirror)
    })
    it.each(fixtures.cases)(
        'preserves the complete original $method plan',
        ({ method, input, plan }) => {
            const actual =
                method === 'buildEvmToSubtensorPlan'
                    ? buildEvmToSubtensorPlan(input)
                    : buildSubtensorToEvmPlan(input)
            expect(actual).toEqual(plan)
        }
    )
})
