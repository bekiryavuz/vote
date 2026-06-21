import { randomUUID } from 'node:crypto';
import { config } from '@/infrastructure/config';
import { buildPollTally, optionFromLabel, PollMeta, PollOption } from '@/domain/poll';
import { buildSlackBlocks } from '@/domain/render/slackBlocks';
import type { PollRepository, SlackGateway, TeamsGateway } from '@/application/ports';

export type ScheduledPollInput = { question: string; options: PollOption[]; creator: string };

export type ScheduledPollResult =
    | { ok: false; error: string }
    | { ok: true; pollId: string; slackTs: string; teamsActivityId: string | null; teamsError: string | null };

// Cron poll: post to Slack, persist refs, then (if configured) post to Teams capturing
// BOTH the activity id and the new-thread reference for later updates.
export function makeCreateScheduledPoll(repo: PollRepository, slack: SlackGateway, teams: TeamsGateway) {
    return async function createScheduledPoll(input: ScheduledPollInput): Promise<ScheduledPollResult> {
        const pollId = randomUUID();
        const meta: PollMeta = { question: input.question, options: input.options, creator: input.creator };
        const tally = buildPollTally(meta.options.length, []);
        const blocks = buildSlackBlocks(meta, tally);

        const posted = await slack.postPoll(config.slack.channelId, blocks, meta.question);
        if (!posted.ok || !posted.ts) {
            return { ok: false, error: posted.error ?? 'slack_post_failed' };
        }
        await repo.saveMeta(pollId, meta);
        await repo.setSlackRef(pollId, posted.ts, config.slack.channelId);

        let teamsActivityId: string | null = null;
        let teamsError: string | null = null;
        if (teams.isConfigured()) {
            try {
                const resolved = await teams.resolveSendReference();
                if (!resolved) {
                    teamsError = 'Teams conversation reference missing';
                } else {
                    await repo.saveTeamsRefKey(pollId, resolved.key);
                    await repo.saveTeamsRefInline(pollId, resolved.reference);
                    const sent = await teams.sendPoll(pollId, meta, tally, resolved.reference);
                    if (sent?.activityId) {
                        teamsActivityId = sent.activityId;
                        await repo.saveTeamsActivityId(pollId, sent.activityId);
                        // The message lives in a NEW channel thread; persist that thread's
                        // reference so updateActivity later targets the right conversation.
                        if (sent.reference) {
                            await repo.saveTeamsRefInline(pollId, sent.reference);
                        }
                    } else {
                        teamsError = 'Teams activity id missing';
                    }
                }
            } catch {
                teamsError = 'Teams send failed';
            }
        }

        return { ok: true, pollId, slackTs: posted.ts, teamsActivityId, teamsError };
    };
}

export type ModalPollInput = { question: string; optionsRaw: string; userId: string; channelId: string | null };

// Slack modal poll: Slack-only (no Teams send). Posts to the channel, DM fallback.
export function makeCreatePollFromModal(repo: PollRepository, slack: SlackGateway) {
    return async function createPollFromModal(input: ModalPollInput): Promise<void> {
        const options = input.optionsRaw
            .split('\n')
            .map((opt) => opt.trim())
            .filter(Boolean)
            .map(optionFromLabel);
        const pollId = randomUUID();
        const meta: PollMeta = { question: input.question, options, creator: input.userId };
        const tally = buildPollTally(meta.options.length, []);
        const blocks = buildSlackBlocks(meta, tally);

        const posted = await slack.postPoll(input.channelId || input.userId, blocks, meta.question);
        if (posted.ok && posted.ts) {
            await repo.saveMeta(pollId, meta);
            await repo.setSlackRef(pollId, posted.ts, input.channelId);
        }
    };
}
