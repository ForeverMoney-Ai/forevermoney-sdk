import { ForeverMoneyError } from '../core/errors.js'

export type BridgeAsset = 'tao' | `sn${number}`

const SUBNET_ASSET = /^sn[1-9]\d*$/

export function isSubnetAsset(
    asset: BridgeAsset | undefined
): asset is `sn${number}` {
    return asset !== undefined && SUBNET_ASSET.test(asset)
}

/** Deployment `contracts` key for an asset: `wrappedTao` or `wrappedSnNN`. */
export function assetTokenKey(asset: BridgeAsset = 'tao'): string {
    if (asset !== 'tao' && !isSubnetAsset(asset)) {
        throw new ForeverMoneyError(
            'INVALID_TRANSACTION_PLAN',
            'Asset must be "tao" or a configured subnet token such as "sn80".'
        )
    }
    return asset === 'tao' ? 'wrappedTao' : `wrappedSn${asset.slice(2)}`
}

/** The asset's token in a deployment `contracts` map, or null when not deployed there. */
export function assetToken<T extends string>(
    contracts: object,
    asset: BridgeAsset = 'tao'
): T | null {
    return (
        (contracts as Readonly<Record<string, T | null | undefined>>)[
            assetTokenKey(asset)
        ] ?? null
    )
}
