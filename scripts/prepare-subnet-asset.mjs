import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'

const deploymentPath = fileURLToPath(
    new URL('../src/chains/deployment.ts', import.meta.url)
)

function address(value, label) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value))
        throw new Error(`${label} must be an EVM address`)
    const result = getAddress(value)
    if (/^0x0{40}$/i.test(result)) throw new Error(`${label} must be nonzero`)
    return result
}

function insertIntoChain(source, chain, nextChain, key, value) {
    const start = source.indexOf(`    ${chain}: Object.freeze({`)
    const end = source.indexOf(`    ${nextChain}: Object.freeze({`, start + 1)
    if (start < 0 || end < 0) throw new Error(`SDK ${chain} section not found`)
    const section = source.slice(start, end)
    const existing = section.match(
        new RegExp(`\\b${key}: (?:getAddress\\(\\s*'([^']+)'\\s*\\)|null)`)
    )
    if (existing) {
        const current = existing[1]
            ? address(existing[1], `${chain}.${key}`)
            : null
        if (current?.toLowerCase() !== value?.toLowerCase())
            throw new Error(`SDK ${chain}.${key} already has a different value`)
        return source
    }
    const marker = '            ccipRouter: getAddress('
    const position = section.indexOf(marker)
    if (position < 0) throw new Error(`SDK ${chain} insertion point not found`)
    const entry = value
        ? `            ${key}: getAddress('${value}'),\n`
        : `            ${key}: null,\n`
    return (
        source.slice(0, start + position) +
        entry +
        source.slice(start + position)
    )
}

export function prepareSubnetAsset(input, source) {
    if (!input || typeof input !== 'object' || !input.dashboard || !input.sdk)
        throw new Error('Expected dashboard and sdk sections in one JSON file')
    const { dashboard, sdk } = input
    const netuid = dashboard.netuid
    if (!Number.isSafeInteger(netuid) || netuid <= 0)
        throw new Error('dashboard.netuid must be a positive integer')
    const key = `wrappedSn${netuid}`
    const subtensor = address(
        sdk.subtensorTokenAddress,
        'sdk.subtensorTokenAddress'
    )
    if (!Array.isArray(dashboard.deployments) || !dashboard.deployments.length)
        throw new Error('At least one deployment is required')
    const chains = new Map()
    for (const deployment of dashboard.deployments) {
        if (!['base', 'robinhood'].includes(deployment.network))
            throw new Error('Only Base and Robinhood deployments are supported')
        if (chains.has(deployment.network))
            throw new Error('Duplicate network deployment')
        chains.set(
            deployment.network,
            address(deployment.token0Address, `${deployment.network} token`)
        )
    }
    const constant = `export const SN${netuid}_NETUID = ${netuid}n`
    if (!source.includes(constant)) {
        if (new RegExp(`export const SN${netuid}_NETUID\\s*=`).test(source))
            throw new Error(`SDK SN${netuid} netuid constant conflicts`)
        const marker = 'export const FOREVERMONEY_DEPLOYMENT_VERSION'
        if (!source.includes(marker))
            throw new Error('SDK constant insertion point not found')
        source = source.replace(marker, `${constant}\n\n${marker}`)
    }
    source = insertIntoChain(
        source,
        'base',
        'robinhood',
        key,
        chains.get('base') ?? null
    )
    source = insertIntoChain(
        source,
        'robinhood',
        'subtensor',
        key,
        chains.get('robinhood') ?? null
    )
    const subtensorStart = source.indexOf('    subtensor: Object.freeze({')
    if (subtensorStart < 0) throw new Error('SDK Subtensor section not found')
    const subtensorTail = source.slice(subtensorStart)
    const existing = subtensorTail.match(
        new RegExp(`\\b${key}: getAddress\\(\\s*'([^']+)'\\s*\\)`)
    )
    if (existing) {
        if (
            address(existing[1], `subtensor.${key}`).toLowerCase() !==
            subtensor.toLowerCase()
        )
            throw new Error(
                `SDK subtensor.${key} already has a different value`
            )
    } else {
        if (new RegExp(`\\b${key}:`).test(subtensorTail))
            throw new Error(
                `SDK subtensor.${key} has an unsupported existing value`
            )
        const marker = '            ccipRouter: getAddress('
        const offset = subtensorTail.indexOf(marker)
        if (offset < 0)
            throw new Error('SDK Subtensor insertion point not found')
        const position = subtensorStart + offset
        source =
            source.slice(0, position) +
            `            ${key}: getAddress('${subtensor}'),\n` +
            source.slice(position)
    }
    return source
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        const args = process.argv.slice(2)
        if (
            args.length < 1 ||
            args.length > 2 ||
            (args[1] && args[1] !== '--apply')
        )
            throw new Error(
                'Usage: node scripts/prepare-subnet-asset.mjs config.json [--apply]'
            )
        const input = JSON.parse(readFileSync(args[0], 'utf8'))
        const before = readFileSync(deploymentPath, 'utf8')
        const after = prepareSubnetAsset(input, before)
        const changed = before !== after
        if (args[1] === '--apply' && changed)
            writeFileSync(deploymentPath, after)
        console.log(
            JSON.stringify({
                sdkSource: deploymentPath,
                netuid: input.dashboard.netuid,
                changed,
                applied: args[1] === '--apply',
                note: 'SDK source only. Package publication and app SDK upgrade are separate release steps.',
            })
        )
    } catch (error) {
        console.error('SDK preparation failed:', error.message)
        process.exitCode = 1
    }
}
