import {
    encodeAbiParameters,
    encodeEventTopics,
    type Abi,
    type Hex,
} from 'viem'

/** Build RPC event fixtures from indexed topics and non-indexed data. */
export function eventLog(
    abi: Abi,
    eventName: string,
    values: readonly unknown[]
) {
    const event = abi.find(
        (item) => item.type === 'event' && item.name === eventName
    )
    if (event?.type !== 'event') throw new Error(`Missing event ${eventName}`)
    const args = Object.fromEntries(
        event.inputs.map((input, index) => [input.name, values[index]])
    )
    return {
        topics: encodeEventTopics({ abi: [event], eventName, args }) as Hex[],
        data: encodeAbiParameters(
            event.inputs.filter((input) => !input.indexed),
            values.filter((_, index) => !event.inputs[index]!.indexed)
        ),
    }
}
