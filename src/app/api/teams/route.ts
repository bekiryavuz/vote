import type { Request as BotRequest, Response as BotResponse } from 'botbuilder';
import { adapter } from '@/infrastructure/teams/adapter';
import { WebApiResponse } from '@/infrastructure/teams/webResponse';
import { recordTeamsVote, repo } from '@/composition';

export const runtime = 'nodejs';

export async function POST(req: Request) {
    const body = await req.json().catch(() => ({}));
    const headers = Object.fromEntries(req.headers.entries());
    const webRequest: BotRequest = { body, headers, method: req.method };
    const webResponse = new WebApiResponse();
    try {
        await adapter.process(webRequest, webResponse as unknown as BotResponse, async (context) => {
            const storedRefKey = await repo.saveConversationReference(context);
            if (context.activity.type === 'invoke') {
                await context.sendActivity({ type: 'invokeResponse', value: { status: 200 } });
            }
            try {
                await recordTeamsVote(context, storedRefKey);
            } catch (error) {
                console.error('Failed to handle Teams activity', {
                    type: context.activity.type,
                    name: context.activity.name,
                    error
                });
            }
        });
    } catch (error) {
        // adapter.process throws on inbound JWT/auth failure BEFORE the bot logic callback
        // runs — surface it explicitly (otherwise only botbuilder's internal log fires).
        console.error('Teams adapter.process failed (inbound auth/delivery?)', {
            hasAuthHeader: Boolean(headers.authorization),
            activityType: (body as { type?: string })?.type,
            error
        });
    }
    return webResponse.toResponse();
}
