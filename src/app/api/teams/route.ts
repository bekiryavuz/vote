import { TurnContext } from 'botbuilder';
import type { Request as BotRequest, Response as BotResponse } from 'botbuilder';
import { buildPollTally, buildSlackBlocks, buildTeamsCard, normalizeLegacyMeta, PollMeta } from '@/lib/poll';
import { kvDelete, kvGetJson, kvGetRaw, kvListKeys, kvSet } from '@/lib/kv';
import { getTeamsConversationReference, storeConversationReference, teamsBotConfigReady, updateTeamsPoll } from '@/lib/teams';
import { adapter } from '@/lib/teamsAdapter';

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

function pollVoteKey(pollId: string, voterKey: string) {
    return `poll:${pollId}:vote:${voterKey}`;
}

function pollVoteTsKey(pollId: string, voterKey: string) {
    return `poll:${pollId}:vote_ts:${voterKey}`;
}

function normalizeIdentity(value: string) {
    return value
        .trim()
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
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

async function listVotes(pollId: string) {
    const keys = await kvListKeys(`poll:${pollId}:vote:*`);
    const deduped = new Map<string, { voter?: string; optionIdx: number; updatedAt: number }>();
    const prefix = `poll:${pollId}:vote:`;
    for (const key of keys) {
        const raw = await kvGetRaw(key);
        const idx = parseInt(String(raw), 10);
        if (Number.isNaN(idx)) {
            continue;
        }
        const voterKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
        const tsRaw = await kvGetRaw(pollVoteTsKey(pollId, voterKey));
        const updatedAt = parseInt(String(tsRaw), 10);
        const ts = Number.isNaN(updatedAt) ? 0 : updatedAt;
        let voter: string | undefined;
        let identityKey: string;
        if (voterKey.startsWith('teams:')) {
            const teamsUserId = voterKey.replace('teams:', '');
            const teamsNameRaw = await kvGetRaw(`poll:${pollId}:teams_user_name:${teamsUserId}`);
            const teamsName = typeof teamsNameRaw === 'string' && teamsNameRaw.trim().length > 0
                ? teamsNameRaw.trim()
                : teamsUserId;
            voter = `teams:${teamsName}`;
            identityKey = `name:${normalizeIdentity(teamsName)}`;
        } else if (voterKey.startsWith('slack:')) {
            voter = voterKey;
            const slackUserId = voterKey.replace('slack:', '');
            const slackNameRaw = await kvGetRaw(`poll:${pollId}:slack_user_name:${slackUserId}`);
            const slackName = typeof slackNameRaw === 'string' && slackNameRaw.trim().length > 0
                ? slackNameRaw.trim()
                : '';
            identityKey = slackName ? `name:${normalizeIdentity(slackName)}` : `slack:${slackUserId}`;
        } else {
            voter = voterKey;
            identityKey = `raw:${voterKey}`;
        }
        const existing = deduped.get(identityKey);
        if (!existing || ts >= existing.updatedAt) {
            deduped.set(identityKey, { voter, optionIdx: idx, updatedAt: ts });
        }
    }
    return Array.from(deduped.values()).map(({ voter, optionIdx }) => ({ voter, optionIdx }));
}

type TeamsUpdateHints = {
    reference?: unknown;
    activityIds?: string[];
    turnContext?: TurnContext;
};

async function updateSlackAndTeams(pollId: string, meta: PollMeta, teamsHints?: TeamsUpdateHints) {
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
        const reference = teamsHints?.reference || await getTeamsReferenceForPoll(pollId);
        const teamsActivityId = await kvGetRaw(`poll:${pollId}:teams_activity_id`);
        const candidateIds = new Set<string>();
        if (typeof teamsActivityId === 'string' && teamsActivityId.trim().length > 0) {
            candidateIds.add(teamsActivityId.trim());
        }
        for (const id of teamsHints?.activityIds || []) {
            if (typeof id === 'string' && id.trim().length > 0) {
                candidateIds.add(id.trim());
            }
        }
        if (reference && candidateIds.size > 0) {
            let updated = false;
            let lastError: unknown = null;
            const candidateIdsArray = Array.from(candidateIds);
            if (teamsHints?.turnContext) {
                for (const activityId of candidateIdsArray) {
                    try {
                        const card = buildTeamsCard(meta, tally, pollId);
                        await teamsHints.turnContext.updateActivity({
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
                        await kvSet(`poll:${pollId}:teams_activity_id`, activityId);
                        updated = true;
                        break;
                    } catch (error) {
                        lastError = error;
                    }
                }
            }
            if (updated) {
                return;
            }
            for (const activityId of candidateIds) {
                try {
                    await updateTeamsPoll(pollId, meta, tally, reference, activityId);
                    await kvSet(`poll:${pollId}:teams_activity_id`, activityId);
                    updated = true;
                    break;
                } catch (error) {
                    lastError = error;
                }
            }
            if (!updated) {
                console.error('Failed to update Teams poll from Teams route', {
                    pollId,
                    candidateActivityIds: candidateIdsArray,
                    error: lastError
                });
            }
        }
    }
}

type SubmitData = { pollId?: string; optionIdx?: number | string };
type ActivityWithFallbackIds = {
    replyToId?: string;
    relatesTo?: { activityId?: string };
    channelData?: {
        legacy?: { replyToId?: string };
        messageid?: string;
        messageId?: string;
    };
};

function getTargetActivityId(activity: ActivityWithFallbackIds) {
    const candidates = [
        activity.replyToId,
        activity.channelData?.legacy?.replyToId,
        activity.relatesTo?.activityId,
        activity.channelData?.messageid,
        activity.channelData?.messageId
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value.trim();
        }
    }
    return null;
}

function getTargetActivityIdCandidates(activity: ActivityWithFallbackIds) {
    const candidates = [
        activity.replyToId,
        activity.channelData?.legacy?.replyToId,
        activity.relatesTo?.activityId,
        activity.channelData?.messageid,
        activity.channelData?.messageId
    ];
    const deduped = new Set<string>();
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim().length > 0) {
            deduped.add(value.trim());
        }
    }
    return Array.from(deduped);
}

function collectActivityIdsFromValue(value: unknown, max = 30) {
    const found = new Set<string>();
    const queue: unknown[] = [value];
    const seen = new Set<unknown>();

    while (queue.length > 0 && found.size < max) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) {
            continue;
        }
        seen.add(current);

        if (Array.isArray(current)) {
            for (const item of current) {
                queue.push(item);
            }
            continue;
        }

        const record = current as Record<string, unknown>;
        for (const [rawKey, rawVal] of Object.entries(record)) {
            const key = rawKey.toLowerCase();
            if (
                typeof rawVal === 'string' &&
                rawVal.trim().length > 0 &&
                (key.includes('replytoid') || key.includes('activityid') || key.includes('messageid'))
            ) {
                found.add(rawVal.trim());
            }
            if (rawVal && typeof rawVal === 'object') {
                queue.push(rawVal);
            }
        }
    }
    return Array.from(found);
}

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
    const currentReference = TurnContext.getConversationReference(context.activity);
    if (storedRefKey) {
        await kvSet(`poll:${pollId}:teams_ref_key`, storedRefKey);
    }
    await kvSet(`poll:${pollId}:teams_ref_inline`, currentReference);
    const userName = typeof context.activity.from?.name === 'string' ? context.activity.from.name.trim() : '';
    if (userName.length > 0) {
        await kvSet(`poll:${pollId}:teams_user_name:${userId}`, userName);
    }
    const activityWithFallbackIds = context.activity as unknown as ActivityWithFallbackIds;
    const targetActivityId = getTargetActivityId(activityWithFallbackIds);
    if (targetActivityId) {
        await kvSet(`poll:${pollId}:teams_activity_id`, targetActivityId);
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

    await updateSlackAndTeams(pollId, meta, {
        reference: currentReference,
        activityIds: [
            ...getTargetActivityIdCandidates(activityWithFallbackIds),
            ...collectActivityIdsFromValue(context.activity)
        ],
        turnContext: context
    });
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
    return webResponse.toResponse();
}
