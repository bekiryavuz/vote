import { TeamsInfo, TurnContext } from 'botbuilder';
import type { Request as BotRequest, Response as BotResponse } from 'botbuilder';
import { buildPollTally, buildSlackBlocks, normalizeLegacyMeta, PollMeta } from '@/lib/poll';
import { kvDelete, kvGetJson, kvGetRaw, kvSet } from '@/lib/kv';
import { getTeamsConversationReference, storeConversationReference, teamsBotConfigReady, updateTeamsPoll } from '@/lib/teams';
import { adapter } from '@/lib/teamsAdapter';
import { listVotes, pollVoteKey, pollVoteTsKey } from '@/lib/votes';

export const runtime = 'nodejs';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
class WebApiResponse {
    private statusCode = 200;
    private headers = new Headers();
    private body: string | null = null;
    public socket = null;

    status(code: number) {
        this.statusCode = code;
        return this;
    }

    header(name: string, value: string) {
        this.headers.set(name, value);
        return this;
    }

    send(body?: unknown) {
        if (body === undefined || body === null) {
            this.body = null;
        } else if (typeof body === 'string') {
            this.body = body;
        } else {
            this.body = JSON.stringify(body);
            this.headers.set('Content-Type', 'application/json');
        }
        return this;
    }

    end() {
        return this;
    }

    toResponse() {
        return new Response(this.body, {
            status: this.statusCode,
            headers: this.headers
        });
    }
}

async function getPollMeta(pollId: string): Promise<PollMeta | null> {
    const raw = await kvGetJson<unknown>(`poll:${pollId}:meta`);
    return normalizeLegacyMeta(raw);
}

async function getTeamsReferenceForPoll(pollId: string) {
    const inlineReference = await kvGetJson(`poll:${pollId}:teams_ref_inline`);
    if (inlineReference) {
        return inlineReference;
    }
    const teamsRefKey = await kvGetRaw(`poll:${pollId}:teams_ref_key`);
    if (typeof teamsRefKey === 'string' && teamsRefKey.length > 0) {
        return kvGetJson(teamsRefKey);
    }
    return getTeamsConversationReference();
}

async function updateSlackAndTeams(pollId: string, meta: PollMeta) {
    const votes = await listVotes(pollId);
    const tally = buildPollTally(meta.options.length, votes);

    const slackTs = await kvGetRaw(`poll:${pollId}:slack_ts`);
    const slackChannelId = await kvGetRaw(`poll:${pollId}:slack_channel_id`);
    if (typeof slackTs === 'string' && typeof slackChannelId === 'string') {
        const blocks = buildSlackBlocks(meta, tally);
        const slackRes = await fetch('https://slack.com/api/chat.update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SLACK_BOT_TOKEN}`
            },
            body: JSON.stringify({
                channel: slackChannelId,
                ts: slackTs,
                blocks
            })
        });
        const slackData = await slackRes.json().catch(() => null);
        if (!slackRes.ok || !slackData?.ok) {
            console.error('Failed to update Slack poll from Teams route', {
                pollId,
                status: slackRes.status,
                slackError: slackData?.error
            });
        }
    }

    if (teamsBotConfigReady()) {
        // Update against the send-time card id + channel reference captured when the poll
        // was posted (/api/send-vote). The inbound vote's replyToId points at the thread
        // root, not the card, so deriving the target from it silently breaks the update.
        const reference = await getTeamsReferenceForPoll(pollId);
        const teamsActivityId = await kvGetRaw(`poll:${pollId}:teams_activity_id`);
        if (reference && typeof teamsActivityId === 'string' && teamsActivityId.trim().length > 0) {
            try {
                await updateTeamsPoll(pollId, meta, tally, reference, teamsActivityId.trim());
            } catch (error) {
                console.error('Failed to update Teams poll from Teams route', {
                    pollId,
                    teamsActivityId,
                    error
                });
            }
        } else {
            console.error('Teams poll update skipped: missing reference or activity id', {
                pollId,
                hasReference: Boolean(reference),
                teamsActivityId
            });
        }
    }
}

type SubmitData = { pollId?: string; optionIdx?: number | string };

function asRecord(value: unknown) {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

function parseJsonString(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return null;
    }
    try {
        return JSON.parse(trimmed);
    } catch {
        return null;
    }
}

function getRecordValueCaseInsensitive(record: Record<string, unknown>, keys: string[]) {
    const lookup = new Set(keys.map((key) => key.toLowerCase()));
    for (const [key, value] of Object.entries(record)) {
        if (lookup.has(key.toLowerCase())) {
            return value;
        }
    }
    return undefined;
}

function extractFromNode(value: unknown): SubmitData | null {
    const node = asRecord(value);
    if (!node) {
        return null;
    }
    const rawPollId = getRecordValueCaseInsensitive(node, ['pollId', 'poll_id', 'pollid']);
    const rawOptionIdx = getRecordValueCaseInsensitive(node, ['optionIdx', 'option_idx', 'optionid', 'option']);
    const pollId = typeof rawPollId === 'string' ? rawPollId : undefined;
    const optionIdx = typeof rawOptionIdx === 'number' || typeof rawOptionIdx === 'string' ? rawOptionIdx : undefined;
    if (!pollId || optionIdx === undefined) {
        return null;
    }
    return { pollId, optionIdx };
}

function extractSubmitData(value: unknown): SubmitData | null {
    const queue: unknown[] = [value];
    const seen = new Set<unknown>();
    while (queue.length > 0) {
        const current = queue.shift();
        if (current == null) {
            continue;
        }
        const parsed = parseJsonString(current);
        if (parsed) {
            queue.push(parsed);
            continue;
        }
        if (Array.isArray(current)) {
            for (const item of current) {
                queue.push(item);
            }
            continue;
        }
        if (typeof current !== 'object' || seen.has(current)) {
            continue;
        }
        seen.add(current);
        const match = extractFromNode(current);
        if (match) {
            return match;
        }
        const record = current as Record<string, unknown>;
        for (const value of Object.values(record)) {
            if (value == null) {
                continue;
            }
            if (typeof value === 'object' || Array.isArray(value)) {
                queue.push(value);
                continue;
            }
            const parsedValue = parseJsonString(value);
            if (parsedValue) {
                queue.push(parsedValue);
            }
        }
    }
    return null;
}

async function handleVote(context: TurnContext, storedRefKey: string | null) {
    const submit = extractSubmitData(context.activity.value);
    if (!submit?.pollId) {
        console.error('Teams vote ignored: submit payload not found', {
            activityType: context.activity.type,
            activityName: context.activity.name,
            valueType: typeof context.activity.value
        });
        return;
    }
    const pollId = submit.pollId;
    const optionIdx = parseInt(String(submit.optionIdx), 10);
    if (!pollId || Number.isNaN(optionIdx)) {
        console.error('Teams vote ignored: invalid poll or option', {
            pollId,
            rawOptionIdx: submit.optionIdx
        });
        return;
    }
    const meta = await getPollMeta(pollId);
    if (!meta) {
        console.error('Teams vote ignored: poll meta missing', { pollId });
        return;
    }
    if (optionIdx < 0 || optionIdx >= meta.options.length) {
        console.error('Teams vote ignored: option out of range', {
            pollId,
            optionIdx,
            optionsLength: meta.options.length
        });
        return;
    }
    const from = context.activity.from as { aadObjectId?: string; id?: string } | undefined;
    const userId = from?.aadObjectId || from?.id;
    if (!userId) {
        console.error('Teams vote ignored: missing user id', { pollId });
        return;
    }
    // Preserve the send-time channel reference and card activity id (stored by
    // /api/send-vote). Do NOT overwrite them with the inbound vote's thread-scoped
    // reference / replyToId — that is exactly what was breaking the card update.
    if (storedRefKey) {
        await kvSet(`poll:${pollId}:teams_ref_key`, storedRefKey);
    }
    const userName = typeof context.activity.from?.name === 'string' ? context.activity.from.name.trim() : '';
    if (userName.length > 0) {
        await kvSet(`poll:${pollId}:teams_user_name:${userId}`, userName);
    }
    // Best-effort email so the same person is de-duplicated across Slack + Teams even when
    // display names differ. Falls back to name-based dedup if the roster lookup fails.
    try {
        const member = await TeamsInfo.getMember(context, from?.id || userId);
        const memberRecord = member as { email?: string; userPrincipalName?: string } | undefined;
        const email = memberRecord?.email || memberRecord?.userPrincipalName || '';
        if (email) {
            await kvSet(`poll:${pollId}:teams_user_email:${userId}`, email);
        }
    } catch (error) {
        console.error('Teams getMember failed (email dedup will fall back to name)', { pollId, error });
    }
    const voteKey = pollVoteKey(pollId, `teams:${userId}`);
    const voteTsKey = pollVoteTsKey(pollId, `teams:${userId}`);
    const currentVal = await kvGetRaw(voteKey);
    const currentIdx = parseInt(String(currentVal), 10);
    if (!Number.isNaN(currentIdx) && currentIdx === optionIdx) {
        await kvDelete(voteKey);
        await kvDelete(voteTsKey);
    } else {
        await kvSet(voteKey, String(optionIdx));
        await kvSet(voteTsKey, String(Date.now()));
    }

    await updateSlackAndTeams(pollId, meta);
}

export async function POST(req: Request) {
    const body = await req.json().catch(() => ({}));
    const headers = Object.fromEntries(req.headers.entries());
    const webRequest: BotRequest = {
        body,
        headers,
        method: req.method
    };
    const webResponse = new WebApiResponse();
    try {
        await adapter.process(webRequest, webResponse as unknown as BotResponse, async (context) => {
            const storedRefKey = await storeConversationReference(context);
            if (context.activity.type === 'invoke') {
                await context.sendActivity({
                    type: 'invokeResponse',
                    value: { status: 200 }
                });
            }
            try {
                await handleVote(context, storedRefKey);
            } catch (error) {
                console.error('Failed to handle Teams activity', {
                    type: context.activity.type,
                    name: context.activity.name,
                    error
                });
            }
        });
    } catch (error) {
        // adapter.process throws on inbound JWT/auth failure BEFORE the bot logic
        // callback runs — so votes are never recorded and the card never updates.
        // Surface it explicitly (otherwise only botbuilder's internal log fires).
        console.error('Teams adapter.process failed (inbound auth/delivery?)', {
            hasAuthHeader: Boolean(headers.authorization),
            activityType: (body as { type?: string })?.type,
            error
        });
    }
    return webResponse.toResponse();
}
