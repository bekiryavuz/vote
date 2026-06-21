import { decideVote } from '@/domain/tally';
import { slackVoterKey } from '@/domain/identity';
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

        const voterKey = slackVoterKey(input.userId);
        const decision = decideVote(await repo.getVote(pollId, voterKey), input.optionIdx);
        if (decision.action === 'clear') {
            await repo.clearVote(pollId, voterKey);
        } else {
            const profile = await slack.getProfile(input.userId);
            await repo.setVote(pollId, voterKey, decision.optionIdx);
            await repo.saveSlackVoter(pollId, input.userId, profile.name || input.slackHandle, profile.email || undefined);
        }

        await syncPoll(pollId, meta, { channelId: input.channelId, ts: input.ts });
    };
}
