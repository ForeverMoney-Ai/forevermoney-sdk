import {
    BaseError,
    ContractFunctionRevertedError,
    ExecutionRevertedError,
} from 'viem'
import { ForeverMoneyError } from './errors.js'

function stringProperty(value: unknown, property: string): string | undefined {
    if (typeof value !== 'object' || value === null || !(property in value)) {
        return undefined
    }
    const entry = (value as Record<string, unknown>)[property]
    return typeof entry === 'string' ? entry : undefined
}

export async function providerOperation<T>(
    operation: string,
    action: () => Promise<T>
): Promise<T> {
    try {
        return await action()
    } catch (error) {
        if (error instanceof ForeverMoneyError) throw error
        const revert =
            error instanceof BaseError
                ? error.walk(
                      (cause) =>
                          cause instanceof ContractFunctionRevertedError ||
                          cause instanceof ExecutionRevertedError
                  )
                : undefined
        const viemRevert =
            revert instanceof ContractFunctionRevertedError ||
            revert instanceof ExecutionRevertedError
        const causeCode = viemRevert
            ? revert.name
            : stringProperty(error, 'code')
        const reason = viemRevert
            ? revert instanceof ContractFunctionRevertedError
                ? (revert.data?.errorName ?? revert.reason)
                : undefined
            : stringProperty(error, 'reason')
        const reverted = viemRevert || causeCode === 'CALL_EXCEPTION'
        throw new ForeverMoneyError(
            reverted ? 'SIMULATION_REVERTED' : 'RPC_ERROR',
            reverted ? `${operation} reverted.` : `${operation} failed.`,
            {
                ...(causeCode === undefined ? {} : { causeCode }),
                ...(reason === undefined ? {} : { reason }),
            }
        )
    }
}
