import { keccak256, stringToBytes } from 'viem'
import { FOREVERMONEY_DEPLOYMENT_VERSION } from '../chains/deployment.js'

export type TransactionStepKind = 'approval' | 'transaction'
export type TransactionAction =
    | 'bridge.base-to-subtensor'
    | 'bridge.robinhood-to-subtensor'
    | 'bridge.subtensor-to-base'
    | 'bridge.subtensor-to-robinhood'
    | 'vault.claim-fees'
    | 'vault.create'
    | 'vault.deposit'
    | 'vault.stake'
    | 'vault.unstake'
    | 'vault.withdraw'

export interface PreparedTransaction {
    readonly chainId: number
    readonly from: string
    readonly to: string
    readonly data: string
    readonly value: string
    readonly gasLimit?: string
}

export interface TransactionStep {
    readonly kind: TransactionStepKind
    readonly label: string
    readonly transaction: PreparedTransaction
}

export interface TransactionPlan {
    readonly version: '1'
    readonly deploymentVersion: typeof FOREVERMONEY_DEPLOYMENT_VERSION
    readonly action: TransactionAction
    readonly summary: string
    readonly steps: readonly TransactionStep[]
    readonly hash: string
}

type UnhashedPlan = Omit<
    TransactionPlan,
    'deploymentVersion' | 'hash' | 'version'
>

export function createTransactionPlan(plan: UnhashedPlan): TransactionPlan {
    const steps = plan.steps.map((step) =>
        Object.freeze({
            ...step,
            transaction: Object.freeze({ ...step.transaction }),
        })
    )
    const versionedPlan = {
        version: '1' as const,
        deploymentVersion: FOREVERMONEY_DEPLOYMENT_VERSION,
        action: plan.action,
        summary: plan.summary,
        steps: Object.freeze(steps),
    }
    return Object.freeze({
        ...versionedPlan,
        hash: keccak256(stringToBytes(JSON.stringify(versionedPlan))),
    })
}
