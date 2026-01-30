import { TurnContext } from 'botbuilder';
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

    send(body?: any) {
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
    const raw = await kvGetJson<any>(`poll:${pollId}:meta`);
    return normalizeLegacyMeta(raw);
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
        await fetch('https://slack.com/api/chat.update', {
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
    }

    if (teamsBotConfigReady()) {
        const teamsActivityId = await kvGetRaw(`poll:${pollId}:teams_activity_id`);
        const teamsRefKey = await kvGetRaw(`poll:${pollId}:teams_ref_key`);
        const reference = teamsRefKey ? await kvGetRaw(String(teamsRefKey)) : await getTeamsConversationReference();
        if (typeof teamsActivityId === 'string' && reference) {
            await updateTeamsPoll(pollId, meta, tally, reference, teamsActivityId);
        }
    }
}

async function handleVote(context: TurnContext) {
    const value = (context.activity.value as any)?.data || context.activity.value;
    if (!value || typeof value !== 'object') {
        return;
    }
    const pollId = value.pollId;
    const optionIdx = parseInt(String(value.optionIdx), 10);
    if (!pollId || Number.isNaN(optionIdx)) {
        return;
    }
    const meta = await getPollMeta(pollId);
    if (!meta) {
        return;
    }
    const userId = (context.activity.from as any)?.aadObjectId || context.activity.from?.id;
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
    const webRequest = {
        body,
        headers,
        method: req.method
    };
    const webResponse = new WebApiResponse();
    await adapter.process(webRequest as any, webResponse as any, async (context) => {
        await storeConversationReference(context);
        await handleVote(context);
    });
    return webResponse.toResponse();
}
