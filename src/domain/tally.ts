// Pure vote-toggle decision shared by both vote paths: clicking your current option
// clears the vote, clicking a different option sets it.

export type VoteDecision = { action: 'clear' | 'set'; optionIdx: number };

export function decideVote(currentIdx: number | null, incomingIdx: number): VoteDecision {
    if (currentIdx !== null && !Number.isNaN(currentIdx) && currentIdx === incomingIdx) {
        return { action: 'clear', optionIdx: incomingIdx };
    }
    return { action: 'set', optionIdx: incomingIdx };
}
