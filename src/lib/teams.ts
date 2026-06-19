import { Activity, ConversationReference, TeamsInfo, TurnContext } from 'botbuilder';
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
        console.error('sendTeamsPoll: conversation reference did not parse', {
            pollId,
            rawReferenceType: typeof rawReference
        });
        return null;
    }
    const conversationId = typeof reference.conversation?.id === 'string' ? reference.conversation.id : '';
    // The channel id for sendMessageToTeamsChannel is the bare channel id, without any
    // ;messageid= thread suffix. Derive it from the (real) reference, fall back to env.
    const teamsChannelId = conversationId.split(';')[0] || TEAMS_CHANNEL_ID;
    let activityId: string | null = null;
    let createdReference: Partial<ConversationReference> | null = null;
    await adapter.continueConversationAsync(botAppId, reference, async (context) => {
        const card = buildTeamsCard(meta, tally, pollId);
        // NOTE: deliberately NO top-level `text`. Combining `text` + an adaptive card
        // in the new-conversation create call makes Teams reject it with
        // "Activity resulted into multiple skype activities". The card renders the question.
        const activity = {
            type: 'message',
            attachments: [
                {
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    content: card
                }
            ]
        } as unknown as Activity;
        // A plain proactive sendActivity to a Teams channel returns an EMPTY
        // ResourceResponse ({}), so the card id is never captured and the poll can
        // never be updated. sendMessageToTeamsChannel posts the message AND returns
        // both its activity id and a conversation reference usable for updateActivity.
        const [newReference, newActivityId] = await TeamsInfo.sendMessageToTeamsChannel(
            context,
            activity,
            teamsChannelId,
            botAppId
        );
        createdReference = newReference ?? null;
        activityId = newActivityId ?? null;
        console.error('sendTeamsPoll: sendMessageToTeamsChannel result', {
            pollId,
            activityId,
            teamsChannelId,
            hasReference: Boolean(createdReference)
        });
    });
    if (!activityId) {
        return null;
    }
    return { activityId, reference: createdReference };
}

export async function updateTeamsPoll(pollId: string, meta: PollMeta, tally: PollTally, rawReference: unknown, activityId: string) {
    const reference = parseConversationReference(rawReference);
    if (!reference || !activityId) {
        return;
    }
    await adapter.continueConversationAsync(botAppId, reference, async (context) => {
        const card = buildTeamsCard(meta, tally, pollId);
        // Same rule as the send path: no top-level `text` next to the card, or Teams
        // rejects the update with "Activity resulted into multiple skype activities".
        await context.updateActivity({
            type: 'message',
            id: activityId,
            attachments: [
                {
                    contentType: 'application/vnd.microsoft.card.adaptive',
                    content: card
                }
            ]
        });
    });
}
