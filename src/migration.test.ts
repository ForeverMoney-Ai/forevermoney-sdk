import { describe, expect, it } from 'vitest'
import baseline from './fixtures/pre-viem-plans.json'
import {
    buildEvmToSubtensorPlan,
    buildSubtensorToEvmPlan,
    evmToMirrorSS58,
    foreverMoneyDeployment,
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
              plan: { hash: string }
          }
        | {
              method: 'buildSubtensorToEvmPlan'
              input: BuildSubtensorToEvmPlanRequest
              plan: { hash: string }
          }
    )[]
}

// The saved plans target the legacy gateways. Swap each one for its V5 replacement
// (checksummed in `to`, lowercase inside calldata) and ignore the plan hash, which
// covers the addresses and deployment version. Everything else must be unchanged.
const chains = ['base', 'robinhood', 'subtensor'] as const
function withV5Gateways(value: unknown): unknown {
    let text = JSON.stringify(value)
    for (const chain of chains) {
        const { gateway, legacyGateway } =
            foreverMoneyDeployment[chain].contracts
        text = text
            .replaceAll(legacyGateway, gateway)
            .replaceAll(
                legacyGateway.slice(2).toLowerCase(),
                gateway.slice(2).toLowerCase()
            )
    }
    return {
        ...JSON.parse(text),
        deploymentVersion: foreverMoneyDeployment.version,
    }
}
function withoutHash(plan: { hash: string }) {
    const { hash, ...rest } = plan
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/)
    return rest
}

describe('dependency and V5 gateway migration', () => {
    it('preserves the Subtensor EVM mirror address', () => {
        expect(
            evmToMirrorSS58('0x1111111111111111111111111111111111111111')
        ).toBe(fixtures.mirror)
    })

    it('uses new gateways and keeps the old ones only for tracking', () => {
        for (const chain of chains) {
            const { gateway, legacyGateway } =
                foreverMoneyDeployment[chain].contracts
            expect(gateway.toLowerCase()).not.toBe(legacyGateway.toLowerCase())
        }
    })

    it.each(fixtures.cases)(
        'preserves the original $method plan apart from deployment metadata',
        ({ method, input, plan }) => {
            const actual =
                method === 'buildEvmToSubtensorPlan'
                    ? buildEvmToSubtensorPlan(input)
                    : buildSubtensorToEvmPlan(input)
            expect(withoutHash(actual)).toEqual(
                withoutHash(withV5Gateways(plan) as typeof plan)
            )
        }
    )
})
