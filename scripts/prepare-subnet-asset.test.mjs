import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { prepareSubnetAsset } from './prepare-subnet-asset.mjs'

const source = readFileSync(
    new URL('../src/chains/deployment.ts', import.meta.url),
    'utf8'
)
const input = {
    dashboard: {
        netuid: 121,
        deployments: [
            {
                network: 'base',
                token0Address: '0x0000000000000000000000000000000000000121',
            },
        ],
    },
    sdk: {
        subtensorTokenAddress: '0x0000000000000000000000000000000000000221',
    },
}

test('prepares a Base-only asset and is idempotent', () => {
    const next = prepareSubnetAsset(input, source)
    assert.match(next, /export const SN121_NETUID = 121n/)
    assert.match(
        next,
        /wrappedSn121: getAddress\('0x0000000000000000000000000000000000000121'\)/
    )
    assert.match(next, /wrappedSn121: null/)
    assert.match(
        next,
        /wrappedSn121: getAddress\('0x0000000000000000000000000000000000000221'\)/
    )
    assert.equal(prepareSubnetAsset(input, next), next)
})

test('rejects conflicting SDK addresses', () => {
    const next = prepareSubnetAsset(input, source)
    const conflicting = structuredClone(input)
    conflicting.sdk.subtensorTokenAddress =
        '0x0000000000000000000000000000000000000999'
    assert.throws(
        () => prepareSubnetAsset(conflicting, next),
        /different value/
    )
})
