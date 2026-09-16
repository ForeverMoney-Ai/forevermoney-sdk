import {
    bridgeMessageIdFromReceipt,
    createForeverMoneyClient,
    foreverMoneyAbis,
    foreverMoneyDeployment,
    http,
    MIN_LIQUID_SUBTENSOR_TO_EVM_WEI,
    parseTaoAmount,
    toViemTransaction,
} from '@forevermoney/sdk'
import {
    createPublicClient,
    createWalletClient,
    custom,
    defineChain,
    parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const required = (name) => {
    const value = process.env[name]
    if (value === undefined || value === '') {
        throw new Error(`${name} is required.`)
    }
    return value
}

if (process.env.CI !== undefined) {
    throw new Error('The live canary cannot run in CI.')
}

const privateKey = required('FOREVERMONEY_CANARY_PRIVATE_KEY')
const source = required('FOREVERMONEY_CANARY_SOURCE')
const destination = required('FOREVERMONEY_CANARY_DESTINATION')
const amountWei = parseTaoAmount(required('FOREVERMONEY_CANARY_AMOUNT_TAO'))
const baseRpcUrl = required('BASE_RPC_URL')
const subtensorRpcUrl = required('SUBTENSOR_RPC_URL')

if (source !== 'base' && source !== 'subtensor') {
    throw new Error('FOREVERMONEY_CANARY_SOURCE must be base or subtensor.')
}
const maximumAmountWei =
    source === 'subtensor'
        ? MIN_LIQUID_SUBTENSOR_TO_EVM_WEI
        : parseTaoAmount('0.001')
const maximumWalletBalanceWei = parseTaoAmount('0.05')
if (amountWei > maximumAmountWei) {
    throw new Error(
        `The live canary amount cannot exceed ${source === 'subtensor' ? '0.002' : '0.001'} TAO for ${source}.`
    )
}
if (source === 'subtensor' && amountWei < MIN_LIQUID_SUBTENSOR_TO_EVM_WEI) {
    throw new Error('The liquid Subtensor canary requires 0.002 TAO.')
}

const client = createForeverMoneyClient({
    transports: {
        base: http(baseRpcUrl),
        subtensor: http(subtensorRpcUrl),
    },
})
await client.verifyConnections()

const sourceRpcUrl = source === 'base' ? baseRpcUrl : subtensorRpcUrl
const sourceChainId =
    source === 'base'
        ? foreverMoneyDeployment.base.chainId
        : foreverMoneyDeployment.subtensor.chainId
const chain = defineChain({
    id: sourceChainId,
    name: source === 'base' ? 'Base' : 'Subtensor',
    nativeCurrency: {
        name: source === 'base' ? 'Ether' : 'TAO',
        symbol: source === 'base' ? 'ETH' : 'TAO',
        decimals: 18,
    },
    rpcUrls: { default: { http: [sourceRpcUrl] } },
})
const transport = custom(http(sourceRpcUrl), { retryCount: 0 })
const provider = createPublicClient({ chain, transport })
const account = privateKeyToAccount(privateKey)
const wallet = createWalletClient({ account, chain, transport })
const sender = account.address
const nativeBalance = await provider.getBalance({ address: sender })
if (nativeBalance > maximumWalletBalanceWei) {
    throw new Error(
        'The live canary wallet holds more than 0.05 native units. Use a dedicated low-balance wallet.'
    )
}
if (source === 'base') {
    const wrappedTaoBalance = await provider.readContract({
        address: foreverMoneyDeployment.base.contracts.wrappedTao,
        abi: parseAbi(foreverMoneyAbis.erc20),
        functionName: 'balanceOf',
        args: [sender],
    })
    if (wrappedTaoBalance > maximumWalletBalanceWei) {
        throw new Error(
            'The live canary wallet holds more than 0.05 wrapped TAO. Use a dedicated low-balance wallet.'
        )
    }
    if (wrappedTaoBalance < amountWei) {
        throw new Error('The live canary wallet has insufficient wrapped TAO.')
    }
} else if (nativeBalance < amountWei) {
    throw new Error('The live canary wallet has insufficient liquid TAO.')
}

const prepared =
    source === 'base'
        ? await client.bridge.prepareBaseToSubtensor({
              sender,
              amountWei,
              destination,
              delivery: 'staked',
          })
        : await client.bridge.prepareSubtensorToBase({
              sender,
              recipient: destination,
              amountWei,
              source: 'liquid',
          })

console.log(
    JSON.stringify(
        {
            sender,
            source,
            plan: prepared.plan,
        },
        null,
        2
    )
)

if (
    process.env.FOREVERMONEY_LIVE_CANARY_BROADCAST !==
    'I_ACKNOWLEDGE_THIS_SENDS_REAL_FUNDS'
) {
    console.log('Dry run only. No transaction was signed or broadcast.')
    process.exit(0)
}

const direction = source === 'base' ? 'base-to-subtensor' : 'subtensor-to-base'
let checkpoint
let messageId
for (const step of prepared.plan.steps) {
    if (step.kind === 'transaction') {
        checkpoint = await client.bridge.getDeliveryCheckpoint(direction)
    }
    const hash = await wallet.sendTransaction({
        ...toViemTransaction(step.transaction),
        account,
    })
    console.log(`${step.label}: ${hash}`)
    const receipt = await provider.waitForTransactionReceipt({ hash })
    if (receipt === null || receipt.status !== 'success') {
        throw new Error(`Canary transaction failed: ${hash}`)
    }
    if (step.kind === 'transaction') {
        messageId = bridgeMessageIdFromReceipt(direction, receipt)
        if (messageId === null) {
            throw new Error(
                `Confirmed canary receipt did not contain the canonical bridge event: ${hash}`
            )
        }
        console.log(`CCIP message ID: ${messageId}`)
    }
}

if (checkpoint === undefined || messageId === undefined) {
    throw new Error('Canary plan did not execute a bridge transaction.')
}

for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await client.bridge.getDeliveryStatus({
        direction,
        messageId,
        fromBlock: checkpoint.fromBlock,
    })
    if (status === 'success') {
        console.log('CCIP delivery status: success')
        process.exit(0)
    }
    if (status === 'failure' || status === 'recovery') {
        throw new Error(`CCIP delivery status: ${status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000))
}

throw new Error('Timed out waiting for CCIP delivery after 30 minutes.')
