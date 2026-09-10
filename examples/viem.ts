import type { Chain, PublicClient, Transport, WalletClient } from 'viem'
import {
    createForeverMoneyClient,
    toViemTransaction,
    type BaseToSubtensorRequest,
} from '@forevermoney/sdk'

/** Reuse a wallet application's existing viem transports and signer. */
export async function bridgeWithViem(options: {
    base: PublicClient
    subtensor: PublicClient
    wallet: WalletClient<Transport, Chain>
    request: BaseToSubtensorRequest
}) {
    const sdk = createForeverMoneyClient({
        transports: {
            base: options.base.transport,
            subtensor: options.subtensor.transport,
        },
    })
    await sdk.verifyConnections()
    const prepared = await sdk.bridge.prepareBaseToSubtensor(options.request)
    let checkpoint
    let bridgeHash
    for (const step of prepared.plan.steps) {
        const transaction = toViemTransaction(step.transaction)
        const [chainId, accounts] = await Promise.all([
            options.wallet.getChainId(),
            options.wallet.getAddresses(),
        ])
        if (
            chainId !== transaction.chainId ||
            accounts[0]?.toLowerCase() !== transaction.account.toLowerCase()
        ) {
            throw new Error(
                'The signing account or chain changed. Re-prepare the bridge.'
            )
        }
        if (step.kind === 'transaction')
            checkpoint =
                await sdk.bridge.getDeliveryCheckpoint('base-to-subtensor')
        const hash = await options.wallet.sendTransaction({
            ...transaction,
        })
        const receipt = await options.base.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success')
            throw new Error(`Transaction failed: ${hash}`)
        if (step.kind === 'transaction') bridgeHash = hash
    }
    if (!checkpoint || !bridgeHash)
        throw new Error('Missing bridge transaction or checkpoint.')
    const source = await sdk.bridge.getSourceStatus({
        direction: 'base-to-subtensor',
        transactionHash: bridgeHash,
    })
    if (source.status !== 'confirmed') return { source, checkpoint }
    // Poll again from this checkpoint while waiting; recovery requires a claim flow.
    const delivery = await sdk.bridge.getDeliveryStatus({
        direction: checkpoint.direction,
        messageId: source.messageId,
        fromBlock: checkpoint.fromBlock,
    })
    return { source, checkpoint, delivery }
}
