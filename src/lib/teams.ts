import { TurnContext } from 'botbuilder';
import { kvGetJson, kvSet } from '@/lib/kv';
import { buildTeamsCard, PollMeta, PollTally } from '@/lib/poll';
import { adapter, botAppId } from '@/lib/teamsAdapter';

const TEAMS_CLIENT_ID = process.env.TEAMS_CLIENT_ID!;
const TEAMS_CLIENT_SECRET = process.env.TEAMS_CLIENT_SECRET!;
const TEAMS_TENANT_ID = process.env.TEAMS_TENANT_ID!;
const TEAMS_TEAM_ID = process.env.TEAMS_TEAM_ID!;
const TEAMS_CHANNEL_ID = process.env.TEAMS_CHANNEL_ID!;

export function teamsBotConfigReady() {
    return Boolean(TEAMS_CLIENT_ID && TEAMS_CLIENT_SECRET && TEAMS_TENANT_ID && TEAMS_TEAM_ID && TEAMS_CHANNEL_ID);
}

export function getTeamsRefKey(teamId = TEAMS_TEAM_ID, channelId = TEAMS_CHANNEL_ID) {
    if (!teamId || !channelId) {
        return null;
    }
    return `teams:conversation_ref:${teamId}:${channelId}`;
}

export async function getTeamsConversationReference(teamId = TEAMS_TEAM_ID, channelId = TEAMS_CHANNEL_ID) {
    const key = getTeamsRefKey(teamId, channelId);
    if (!key) {
        return null;
    }
    return kvGetJson<any>(key);
}

export async function storeConversationReference(context: TurnContext) {
    const channelData = context.activity.channelData as any;
    const teamId = channelData?.team?.id;
    const channelId = channelData?.channel?.id;
    if (!teamId || !channelId) {
        return null;
    }
    const reference = TurnContext.getConversationReference(context.activity);
    const key = getTeamsRefKey(teamId, channelId);
    if (!key) {
        return null;
    }
    await kvSet(key, reference);
    return key;
}

export async function sendTeamsPoll(pollId: string, meta: PollMeta, tally: PollTally, reference: any) {
    if (!reference) {
        return null;
    }
    let activityId: string | null = null;
    await adapter.continueConversationAsync(botAppId, reference, async (context) => {
        const card = buildTeamsCard(meta, tally, pollId);
        const response = await context.sendActivity({
            type: 'message',
            text: meta.question,
            attachments: [
                {
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    content: card
                }
            ]
        });
        activityId = response?.id ?? null;
    });
    return activityId;
}

export async function updateTeamsPoll(pollId: string, meta: PollMeta, tally: PollTally, reference: any, activityId: string) {
    if (!reference || !activityId) {
        return;
    }
    await adapter.continueConversationAsync(botAppId, reference, async (context) => {
        const card = buildTeamsCard(meta, tally, pollId);
        await context.updateActivity({
            type: 'message',
            id: activityId,
            text: meta.question,
            attachments: [
                {
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    content: card
                }
            ]
        });
    });
}
