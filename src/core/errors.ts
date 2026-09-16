export type ForeverMoneyErrorCode =
    | 'AMOUNT_BELOW_MINIMUM'
    | 'AMOUNT_NOT_WHOLE_RAO'
    | 'AMOUNT_ZERO'
    | 'CHAIN_MISMATCH'
    | 'INVALID_ADDRESS'
    | 'INVALID_BYTES32'
    | 'INVALID_PARTNER_FEE'
    | 'INVALID_PROVIDER_RESPONSE'
    | 'INVALID_SS58'
    | 'INVALID_TRANSACTION_PLAN'
    | 'MISSING_TRANSPORT'
    | 'RPC_ERROR'
    | 'SIMULATION_REVERTED'

export class ForeverMoneyError extends Error {
    readonly code: ForeverMoneyErrorCode
    readonly details: Readonly<Record<string, unknown>> | undefined

    constructor(
        code: ForeverMoneyErrorCode,
        message: string,
        details?: Readonly<Record<string, unknown>>
    ) {
        super(message)
        this.name = 'ForeverMoneyError'
        this.code = code
        this.details =
            details === undefined ? undefined : Object.freeze({ ...details })
    }
}
