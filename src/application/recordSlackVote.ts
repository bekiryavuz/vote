import { slackVoterKey } from '@/domain/identity';
import { reconcileVote } from '@/application/reconcileVote';
import type { PollRepository, SlackGateway } from '@/application/ports';
import type { SyncPoll } from '@/application/syncPoll';

export type SlackVoteInput = {
    userId: string;
    slackHandle: string;
    optionIdx: number;
    ts: string;
    channelId: string;
};

export function makeRecordSlackVote(repo: PollRepository, slack: SlackGateway, syncPoll: SyncPoll) {
    return async function recordSlackVote(input: SlackVoteInput): Promise<void> {
        const pollId = (await repo.getPollIdBySlackTs(input.ts)) ?? input.ts;
        const meta = await repo.getMeta(pollId);
        if (!meta) {
            console.error('Poll metadata missing or malformed for poll:', pollId);
            return;
        }

        // Resolve identity up front (also on un-vote) so the vote can be reconciled against
        // the same person's Teams vote.
        const profile = await slack.getProfile(input.userId);
        const person = { name: profile.name || input.slackHandle, email: profile.email };
        await repo.saveSlackVoter(pollId, input.userId, person.name, person.email || undefined);
        await reconcileVote(repo, pollId, slackVoterKey(input.userId), person, input.optionIdx);

        await syncPoll(pollId, meta, { channelId: input.channelId, ts: input.ts });
    };
}
