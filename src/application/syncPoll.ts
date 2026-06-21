import { resolveVotes } from '@/domain/dedup';
import { buildPollTally, PollMeta } from '@/domain/poll';
import { buildSlackBlocks } from '@/domain/render/slackBlocks';
import type { PollRepository, SlackGateway, TeamsGateway } from '@/application/ports';

// On click-driven Slack paths the channel/ts of the message are known live; pass them so a
// poll without a persisted channel (DM-fallback modal) or a legacy poll still re-renders.
export type SlackTarget = { channelId?: string; ts?: string };

export type SyncPoll = (pollId: string, meta: PollMeta, slackFallback?: SlackTarget) => Promise<void>;

// THE single source of truth for keeping both surfaces in sync. Callers pass pollId + meta
// (and optionally the live Slack channel/ts); this reads the stored refs itself, so the two
// former divergent copies can't drift again. Re-tallies (with cross-platform dedup) and
// re-renders both cards.
export function makeSyncPoll(repo: PollRepository, slack: SlackGateway, teams: TeamsGateway): SyncPoll {
    return async function syncPoll(pollId, meta, slackFallback) {
        const votes = resolveVotes(await repo.readVoteEntries(pollId));
        const tally = buildPollTally(meta.options.length, votes);

        // Prefer the stored Slack ref (equal to the live one for normal polls); fall back to
        // the live interaction so DM-fallback / legacy polls without a stored ref still update.
        const slackTs = (await repo.getSlackTs(pollId)) ?? slackFallback?.ts ?? null;
        const slackChannelId = (await repo.getSlackChannelId(pollId)) ?? slackFallback?.channelId ?? null;
        if (slackTs && slackChannelId) {
            await slack.updatePoll(slackChannelId, slackTs, buildSlackBlocks(meta, tally));
        }

        if (teams.isConfigured()) {
            const reference = await repo.resolveTeamsReference(pollId);
            const teamsActivityId = await repo.getTeamsActivityId(pollId);
            if (reference && teamsActivityId && teamsActivityId.trim().length > 0) {
                try {
                    await teams.updatePoll(pollId, meta, tally, reference, teamsActivityId.trim());
                } catch (error) {
                    console.error('Failed to update Teams poll', { pollId, teamsActivityId, error });
                }
            } else {
                console.error('Teams poll update skipped: missing reference or activity id', {
                    pollId,
                    hasReference: Boolean(reference),
                    teamsActivityId
                });
            }
        }
    };
}
