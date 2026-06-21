import { Activity, ConversationReference, TeamsInfo, TurnContext } from 'botbuilder';
import { config, teamsBotConfigReady } from '@/infrastructure/config';
import { adapter, botAppId } from '@/infrastructure/teams/adapter';
import { buildTeamsCard } from '@/domain/render/teamsCard';
import { PollMeta, PollTally } from '@/domain/poll';
import type { PollRepository, TeamsGateway } from '@/application/ports';

function parseConversationReference(raw: unknown): ConversationReference | null {
    if (!raw) {
        return null;
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw) as ConversationReference;
        } catch {
            return null;
        }
    }
    if (typeof raw === 'object') {
        return raw as ConversationReference;
    }
    return null;
}

function cardAttachment(card: unknown) {
    return { contentType: 'application/vnd.microsoft.card.adaptive', content: card };
}

export function createTeamsGateway(repo: PollRepository): TeamsGateway {
    return {
        isConfigured() {
            return teamsBotConfigReady();
        },

        async sendPoll(pollId: string, meta: PollMeta, tally: PollTally, rawReference: unknown) {
            const reference = parseConversationReference(rawReference);
            if (!reference) {
                console.error('teamsGateway.sendPoll: conversation reference did not parse', {
                    pollId,
                    rawReferenceType: typeof rawReference
                });
                return null;
            }
            const conversationId = typeof reference.conversation?.id === 'string' ? reference.conversation.id : '';
            // The channel id for sendMessageToTeamsChannel is the bare channel id, without any
            // ;messageid= thread suffix. Derive it from the (real) reference, fall back to env.
            const teamsChannelId = conversationId.split(';')[0] || config.teams.channelId;
            let activityId: string | null = null;
            let createdReference: Partial<ConversationReference> | null = null;
            await adapter.continueConversationAsync(botAppId, reference, async (context) => {
                const card = buildTeamsCard(meta, tally, pollId);
                // NOTE: deliberately NO top-level `text`. Combining `text` + an adaptive card
                // in the new-conversation create call makes Teams reject it with
                // "Activity resulted into multiple skype activities". The card renders the question.
                const activity = { type: 'message', attachments: [cardAttachment(card)] } as unknown as Activity;
                // A plain proactive sendActivity to a Teams channel returns an EMPTY
                // ResourceResponse ({}); sendMessageToTeamsChannel posts the message AND returns
                // both its activity id and a conversation reference usable for updateActivity.
                const [newReference, newActivityId] = await TeamsInfo.sendMessageToTeamsChannel(
                    context,
                    activity,
                    teamsChannelId,
                    botAppId
                );
                createdReference = newReference ?? null;
                activityId = newActivityId ?? null;
            });
            if (!activityId) {
                return null;
            }
            return { activityId, reference: createdReference };
        },

        async updatePoll(pollId: string, meta: PollMeta, tally: PollTally, rawReference: unknown, activityId: string) {
            const reference = parseConversationReference(rawReference);
            if (!reference || !activityId) {
                return;
            }
            // sendMessageToTeamsChannel returns/stores the conversation form
            // "19:...@thread.tacv2;messageid=<id>", but updateActivity wants the BARE message id
            // (the part after messageid=). Passing the full form fails with "Invalid activity ID".
            const messageActivityId = activityId.includes('messageid=')
                ? activityId.split('messageid=').pop()!.split(';')[0]
                : activityId;
            await adapter.continueConversationAsync(botAppId, reference, async (context) => {
                const card = buildTeamsCard(meta, tally, pollId);
                // Same rule as the send path: no top-level `text` next to the card.
                await context.updateActivity({
                    type: 'message',
                    id: messageActivityId,
                    attachments: [cardAttachment(card)]
                });
            });
        },

        async getMemberEmail(context: TurnContext, userId: string) {
            try {
                const member = await TeamsInfo.getMember(context, userId);
                const record = member as { email?: string; userPrincipalName?: string } | undefined;
                return record?.email || record?.userPrincipalName || '';
            } catch (error) {
                console.error('Teams getMember failed (email dedup will fall back to name)', { error });
                return '';
            }
        },

        async resolveSendReference() {
            return repo.resolveConversationReference();
        }
    };
}
