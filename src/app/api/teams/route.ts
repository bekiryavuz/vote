import { TurnContext } from 'botbuilder';
import type { Request as BotRequest, Response as BotResponse } from 'botbuilder';
import { buildPollTally, buildSlackBlocks, normalizeLegacyMeta, PollMeta } from '@/lib/poll';
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

async function getPollMeta(pollId: string): Promise<PollMeta | null> {
    const raw = await kvGetJson<unknown>(`poll:${pollId}:meta`);
    return normalizeLegacyMeta(raw);
}

async function getTeamsReferenceForPoll(pollId: string) {
    const teamsRefKey = await kvGetRaw(`poll:${pollId}:teams_ref_key`);
    if (typeof teamsRefKey === 'string' && teamsRefKey.length > 0) {
        return kvGetJson(teamsRefKey);
    }
    return getTeamsConversationReference();
}

async function listVotes(pollId: string) {
    const keys = await kvListKeys(`poll:${pollId}:vote:*`);
    const votes: Array<{ voter?: string; optionIdx: number }> = [];
    const prefix = `poll:${pollId}:vote:`;
    for (const key of keys) {
        const raw = await kvGetRaw(key);
        const idx = parseInt(String(raw), 10);
        if (Number.isNaN(idx)) {
            continue;
        }
        const voterKey = key.startsWith(prefix) ? key.slice(prefix.length) : key;
        const voter = voterKey.startsWith('teams:')
            ? null
            : voterKey.startsWith('slack:')
                ? voterKey.replace('slack:', '')
                : voterKey;
        votes.push({ voter: voter || undefined, optionIdx: idx });
    }
    return votes;
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
        const teamsActivityId = await kvGetRaw(`poll:${pollId}:teams_activity_id`);
        const reference = await getTeamsReferenceForPoll(pollId);
        if (typeof teamsActivityId === 'string' && reference) {
            await updateTeamsPoll(pollId, meta, tally, reference, teamsActivityId);
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

function extractFromNode(value: unknown): SubmitData | null {
    const node = asRecord(value);
    if (!node) {
        return null;
    }
    const pollId = typeof node.pollId === 'string' ? node.pollId : undefined;
    const optionIdx = typeof node.optionIdx === 'number' || typeof node.optionIdx === 'string' ? node.optionIdx : undefined;
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
        if (!current || typeof current !== 'object' || seen.has(current)) {
            continue;
        }
        seen.add(current);
        const match = extractFromNode(current);
        if (match) {
            return match;
        }
        const record = current as Record<string, unknown>;
        for (const key of ['data', 'action', 'value', 'msteams']) {
            if (record[key] && typeof record[key] === 'object') {
                queue.push(record[key]);
            }
        }
    }
    return null;
}

async function handleVote(context: TurnContext) {
    const submit = extractSubmitData(context.activity.value);
    if (!submit?.pollId) {
        return;
    }
    const pollId = submit.pollId;
    const optionIdx = parseInt(String(submit.optionIdx), 10);
    if (!pollId || Number.isNaN(optionIdx)) {
        return;
    }
    const meta = await getPollMeta(pollId);
    if (!meta) {
        return;
    }
    if (optionIdx < 0 || optionIdx >= meta.options.length) {
        return;
    }
    const from = context.activity.from as { aadObjectId?: string; id?: string } | undefined;
    const userId = from?.aadObjectId || from?.id;
    if (!userId) {
        return;
    }
    const voteKey = pollVoteKey(pollId, `teams:${userId}`);
    const currentVal = await kvGetRaw(voteKey);
    const currentIdx = parseInt(String(currentVal), 10);
    if (!Number.isNaN(currentIdx) && currentIdx === optionIdx) {
        await kvDelete(voteKey);
    } else {
        await kvSet(voteKey, String(optionIdx));
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
    await adapter.process(webRequest, webResponse as unknown as BotResponse, async (context) => {
        await storeConversationReference(context);
        await handleVote(context);
    });
    return webResponse.toResponse();
}
