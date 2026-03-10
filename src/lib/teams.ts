import { TurnContext, ConversationReference } from 'botbuilder';
import { kvGetJson, kvListKeys, kvSet } from '@/lib/kv';
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

type ResolvedTeamsReference = {
    key: string;
    reference: ConversationReference;
};

async function resolveKeyByPatterns(teamId = TEAMS_TEAM_ID, channelId = TEAMS_CHANNEL_ID): Promise<string | null> {
    const exactKey = getTeamsRefKey(teamId, channelId);
    if (exactKey) {
        const exact = await kvGetJson<ConversationReference>(exactKey);
        if (exact) {
            return exactKey;
        }
    }

    if (channelId) {
        const byChannel = await kvListKeys(`teams:conversation_ref:*:${channelId}`);
        if (byChannel.length > 0) {
            return byChannel[0];
        }
    }

    if (teamId) {
        const byTeam = await kvListKeys(`teams:conversation_ref:${teamId}:*`);
        if (byTeam.length > 0) {
            return byTeam[0];
        }
    }

    return null;
}

export async function resolveTeamsConversationReference(teamId = TEAMS_TEAM_ID, channelId = TEAMS_CHANNEL_ID): Promise<ResolvedTeamsReference | null> {
    const key = await resolveKeyByPatterns(teamId, channelId);
    if (!key) {
        return null;
    }
    const reference = await kvGetJson<ConversationReference>(key);
    if (!reference) {
        return null;
    }
    return { key, reference };
}

export async function getTeamsConversationReference(teamId = TEAMS_TEAM_ID, channelId = TEAMS_CHANNEL_ID) {
    const resolved = await resolveTeamsConversationReference(teamId, channelId);
    return resolved?.reference ?? null;
}

function parseConversationReference(raw: unknown): ConversationReference | null {
    if (!raw) {
        return null;
    }
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return parsed as ConversationReference;
        } catch {
            return null;
        }
    }
    if (typeof raw === 'object') {
        return raw as ConversationReference;
    }
    return null;
}

type TeamsChannelData = {
    team?: { id?: string };
    channel?: { id?: string };
};

export async function storeConversationReference(context: TurnContext) {
    const channelData = context.activity.channelData as TeamsChannelData | undefined;
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
    const existing = await kvGetJson<ConversationReference>(key);
    // Do not overwrite a channel-level reference with a thread reply reference.
    if (context.activity.replyToId && existing) {
        return key;
    }
    await kvSet(key, reference);
    return key;
}

export async function sendTeamsPoll(pollId: string, meta: PollMeta, tally: PollTally, rawReference: unknown) {
    const reference = parseConversationReference(rawReference);
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
        const responseWithActivityId = response as { id?: string; activityId?: string } | undefined;
        activityId = responseWithActivityId?.id ?? responseWithActivityId?.activityId ?? null;
    });
    return activityId;
}

export async function updateTeamsPoll(pollId: string, meta: PollMeta, tally: PollTally, rawReference: unknown, activityId: string) {
    const reference = parseConversationReference(rawReference);
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
