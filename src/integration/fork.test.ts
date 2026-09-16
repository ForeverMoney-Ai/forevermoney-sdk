import { AccountId } from '@polkadot-api/substrate-bindings'
import {
    createPublicClient,
    getContract,
    http as viemHttp,
    parseAbi,
} from 'viem'
import { describe, expect, it } from 'vitest'
import {
    ALPHA_GATEWAY_ABI,
    CCIP_ROUTER_ABI,
    SPOKE_GATEWAY_ABI,
} from '../abis/index.js'
import {
    createForeverMoneyClient,
    foreverMoneyDeployment,
    http,
} from '../index.js'

const baseForkRpcUrl = process.env.FOREVERMONEY_BASE_FORK_RPC_URL
const subtensorForkRpcUrl = process.env.FOREVERMONEY_SUBTENSOR_FORK_RPC_URL
const sender = '0x1111111111111111111111111111111111111111'
const destination = AccountId(42).dec(new Uint8Array(32).fill(7))
const bridgeAmountWei = 10_000_000_000_000_000n

describe.skipIf(baseForkRpcUrl === undefined)('Base production fork', () => {
    it('uses production contracts at their canonical addresses', async () => {
        const client = createPublicClient({
            transport: viemHttp(baseForkRpcUrl),
        })
        const { base, subtensor } = foreverMoneyDeployment
        expect(await client.getChainId()).toBe(8453)
        expect(
            await client.getCode({
                address: base.contracts.legacyGateway,
                blockNumber: BigInt(base.deploymentBlock - 1),
            })
        ).toBeUndefined()
        expect(
            await client.getCode({
                address: base.contracts.legacyGateway,
                blockNumber: BigInt(base.deploymentBlock),
            })
        ).toBeTruthy()
        for (const address of [
            base.contracts.gateway,
            base.contracts.legacyGateway,
            base.contracts.wrappedTao,
            base.contracts.vaultFactory,
            base.contracts.vaultManagerImplementation,
        ]) {
            expect(await client.getCode({ address })).toBeTruthy()
        }
        const gateway = getContract({
            address: base.contracts.gateway,
            abi: parseAbi(SPOKE_GATEWAY_ABI),
            client,
        })
        expect(await gateway.read.BITTENSOR_SELECTOR()).toBe(
            subtensor.ccipSelector
        )
        expect((await gateway.read.SUBTENSOR_GATEWAY()).toLowerCase()).toBe(
            subtensor.contracts.gateway.toLowerCase()
        )
        expect(await gateway.read.bridgeFeeBps()).toBe(0)
        expect((await gateway.read.ROUTER()).toLowerCase()).toBe(
            base.contracts.ccipRouter.toLowerCase()
        )
        const router = getContract({
            address: base.contracts.ccipRouter,
            abi: parseAbi(CCIP_ROUTER_ABI),
            client,
        })
        expect(
            await router.read.isOffRamp([
                subtensor.ccipSelector,
                base.contracts.ccipOffRampFromSubtensor,
            ])
        ).toBe(true)
        expect(
            await gateway.read.quoteBridgeToFinney([
                base.contracts.wrappedTao,
                bridgeAmountWei,
                {
                    ss58: `0x${'07'.repeat(32)}`,
                    evmFallback: sender,
                    wantLiquid: true,
                    minTaoOut: bridgeAmountWei,
                },
            ])
        ).toBeGreaterThan(0n)
    })
})

describe.skipIf(subtensorForkRpcUrl === undefined)(
    'Subtensor production fork',
    () => {
        it('uses production contracts and the allowed Base lane', async () => {
            const client = createPublicClient({
                transport: viemHttp(subtensorForkRpcUrl),
            })
            const { base, robinhood, subtensor } = foreverMoneyDeployment
            expect(await client.getChainId()).toBe(964)
            for (const address of [
                subtensor.contracts.gateway,
                subtensor.contracts.legacyGateway,
                subtensor.contracts.alphaVault,
                subtensor.contracts.wrappedTao,
            ]) {
                expect(await client.getCode({ address })).toBeTruthy()
            }
            const gateway = getContract({
                address: subtensor.contracts.gateway,
                abi: parseAbi(ALPHA_GATEWAY_ABI),
                client,
            })
            expect(await gateway.read.allowedLane([base.ccipSelector])).toBe(
                true
            )
            expect(
                await gateway.read.allowedLane([robinhood.ccipSelector])
            ).toBe(true)
            expect(await gateway.read.bridgeFeeBps()).toBe(0)
            expect((await gateway.read.ROUTER()).toLowerCase()).toBe(
                subtensor.contracts.ccipRouter.toLowerCase()
            )
            const router = getContract({
                address: subtensor.contracts.ccipRouter,
                abi: parseAbi(CCIP_ROUTER_ABI),
                client,
            })
            expect(
                await router.read.isOffRamp([
                    base.ccipSelector,
                    subtensor.contracts.ccipOffRampFromBase,
                ])
            ).toBe(true)
            expect(
                await gateway.read.quoteBridgeOut([
                    base.ccipSelector,
                    subtensor.contracts.wrappedTao,
                    sender,
                    bridgeAmountWei,
                ])
            ).toBeGreaterThan(0n)
        })
    }
)

describe.skipIf(
    baseForkRpcUrl === undefined || subtensorForkRpcUrl === undefined
)('SDK fork transports', () => {
    it('accepts the forks without a custom deployment manifest', async () => {
        if (baseForkRpcUrl === undefined || subtensorForkRpcUrl === undefined)
            throw new Error('Fork RPC URLs are required for this test.')
        const client = createForeverMoneyClient({
            transports: {
                base: http(baseForkRpcUrl),
                subtensor: http(subtensorForkRpcUrl),
            },
        })
        await expect(client.verifyConnections()).resolves.toBeUndefined()
        await expect(
            client.bridge.prepareBaseToSubtensor({
                sender,
                amountWei: bridgeAmountWei,
                destination,
                delivery: 'liquid',
            })
        ).resolves.toMatchObject({
            plan: { action: 'bridge.base-to-subtensor' },
        })
    })
})
