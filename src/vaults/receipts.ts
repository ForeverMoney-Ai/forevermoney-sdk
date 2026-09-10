import { decodeEventLog, parseAbi, type Hex } from 'viem'
import { VAULT_FACTORY_ABI } from '../abis/index.js'
import { foreverMoneyDeployment } from '../chains/deployment.js'
import { normalizeEvmAddress } from '../core/addresses.js'
import { isLogFrom, type TransactionReceiptLike } from '../core/receipts.js'

const vaultFactoryAbi = parseAbi(VAULT_FACTORY_ABI)

export function vaultManagerFromCreationReceipt(
    receipt: TransactionReceiptLike
): string | null {
    for (const log of receipt.logs) {
        if (
            !isLogFrom(log, foreverMoneyDeployment.base.contracts.vaultFactory)
        ) {
            continue
        }
        try {
            const parsed = decodeEventLog({
                abi: vaultFactoryAbi,
                data: log.data as Hex,
                topics: [...log.topics] as [Hex, ...Hex[]],
            })
            if (parsed.eventName === 'SnLiquidityManagerCreated') {
                return normalizeEvmAddress(String(parsed.args.manager))
            }
        } catch {
            // A receipt can contain unrelated events from the same contract.
        }
    }
    return null
}
