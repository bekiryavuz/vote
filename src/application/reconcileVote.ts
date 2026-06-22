import { decideVote } from '@/domain/tally';
import { samePerson } from '@/domain/identity';
import type { VoteEntry } from '@/domain/dedup';
import type { PollRepository } from '@/application/ports';

export type Person = { name: string; email: string };

// One person has at most ONE active vote across Slack + Teams. Whichever platform the
// click came from, we look at the person's EFFECTIVE current vote (their latest entry on
// any platform) to decide toggle-vs-set, then clear ALL of their entries (so a removal
// from either side clears everywhere and no stale entry can resurface) and, when setting,
// write a single entry on the platform they just acted from.
export async function reconcileVote(
    repo: PollRepository,
    pollId: string,
    currentVoterKey: string,
    person: Person,
    optionIdx: number
): Promise<void> {
    const entries = await repo.readVoteEntries(pollId);
    const personEntries = entries.filter((entry) => samePerson(person, entry));
    const effective = personEntries.reduce<VoteEntry | null>(
        (latest, entry) => (!latest || entry.updatedAt >= latest.updatedAt ? entry : latest),
        null
    );
    const decision = decideVote(effective ? effective.optionIdx : null, optionIdx);

    const refsToClear = new Set<string>([currentVoterKey, ...personEntries.map((entry) => entry.ref)]);
    for (const ref of refsToClear) {
        await repo.clearVote(pollId, ref);
    }
    if (decision.action === 'set') {
        await repo.setVote(pollId, currentVoterKey, decision.optionIdx);
    }
}
