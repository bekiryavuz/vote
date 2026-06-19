import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { buildPollTally, buildSlackBlocks, normalizeLegacyMeta, PollMeta } from '@/lib/poll';
import { kvDelete, kvGetJson, kvGetRaw, kvSet } from '@/lib/kv';
import { getTeamsConversationReference, updateTeamsPoll, teamsBotConfigReady } from '@/lib/teams';
import { listVotes, pollVoteKey, pollVoteTsKey, slackVoterKey } from '@/lib/votes';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;

// Best-effort: resolve the Slack user's real name + email so the same person can be
// de-duplicated against their Teams vote, and shown by name on the Teams card.
async function getSlackProfile(userId: string): Promise<{ name: string; email: string }> {
    try {
        const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
            headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
        });
        const data = await res.json();
        if (data.ok) {
            const profile = data.user?.profile ?? {};
            const name = profile.real_name || data.user?.real_name || profile.display_name || '';
            const email = profile.email || '';
            return { name, email };
        }
    } catch {
        // Ignore — caller falls back to the payload-provided handle.
    }
    return { name: '', email: '' };
}

async function getPollIdBySlackTs(ts: string) {
    const raw = await kvGetRaw(`poll:slack_ts:${ts}`);
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

async function getPollMeta(pollId: string): Promise<PollMeta | null> {
    const raw = await kvGetJson<unknown>(`poll:${pollId}:meta`);
    return normalizeLegacyMeta(raw);
}

async function getSlackTsForPoll(pollId: string) {
    const raw = await kvGetRaw(`poll:${pollId}:slack_ts`);
    return typeof raw === 'string' ? raw : null;
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

async function updateSlackAndTeams(pollId: string, meta: PollMeta, slackChannelId: string, slackTs: string) {
    const votes = await listVotes(pollId);
    const tally = buildPollTally(meta.options.length, votes);
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
        console.error('Failed to update Slack poll from interactivity route', {
            pollId,
            status: slackRes.status,
            slackError: slackData?.error
        });
    }

    if (teamsBotConfigReady()) {
        const teamsActivityId = await kvGetRaw(`poll:${pollId}:teams_activity_id`);
        const reference = await getTeamsReferenceForPoll(pollId);
        if (typeof teamsActivityId === 'string' && reference) {
            await updateTeamsPoll(pollId, meta, tally, reference, teamsActivityId);
        }
    }
}

export async function POST(req: NextRequest) {
    const form = await req.formData();
    const payload = JSON.parse(form.get('payload') as string);

    // Only handle modal submissions
    if (payload.type === 'view_submission' && payload.view.callback_id === 'create_vote_modal') {
        // Parse question and options
        const question = payload.view.state.values.question.question_input.value;
        const optionsRaw = payload.view.state.values.options.options_input.value;
        const options = optionsRaw.split('\n').map((opt: string) => opt.trim()).filter(Boolean);
        const userId = payload.user.id;
        const channelId = payload.view.private_metadata;

        const pollId = randomUUID();
        const meta: PollMeta = {
            question,
            options: options.map((opt: string) => {
                const label = opt.toUpperCase();
                const emoji = label === 'HOME' ? ':house_with_garden:' : label === 'OFFICE' ? ':office:' : ':grey_question:';
                return { label, emoji };
            }),
            creator: userId
        };
        const tally = buildPollTally(meta.options.length, []);
        const blocks = buildSlackBlocks(meta, tally);

        // Post the poll to the channel
        const postRes = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            },
            body: JSON.stringify({
                channel: channelId || payload.user.id, // fallback to DM if channel not found
                blocks,
                text: question,
            }),
        });
        const postData = await postRes.json();
        // Store poll metadata in KV for later updates
        if (postData.ok) {
            await kvSet(`poll:${pollId}:meta`, meta);
            await kvSet(`poll:${pollId}:slack_ts`, postData.ts);
            if (channelId) {
                await kvSet(`poll:${pollId}:slack_channel_id`, channelId);
            }
            await kvSet(`poll:slack_ts:${postData.ts}`, pollId);
        }
        // Respond with 200 OK and empty body
        return new Response('', { status: 200 });
    }

    // Handle voting button clicks (block actions)
    if (payload.type === 'block_actions') {
        try {
            const action = payload.actions[0];
            const userId = payload.user.id;
            const slackName = payload.user?.name || payload.user?.username || userId;
            const optionIdx = parseInt(action.value.replace('option_', ''));
            const ts = payload.message.ts;
            const channelId = payload.channel.id;
            const pollId = (await getPollIdBySlackTs(ts)) || ts;
            const meta = await getPollMeta(pollId);
            if (!meta) {
                console.error('Poll metadata missing or malformed for poll:', pollId);
                return new Response('', { status: 200 });
            }

            const prefixedKey = pollVoteKey(pollId, slackVoterKey(userId));
            const prefixedTsKey = pollVoteTsKey(pollId, slackVoterKey(userId));
            const legacyKey = pollVoteKey(pollId, userId);
            const legacyTsKey = pollVoteTsKey(pollId, userId);
            const prefixedVal = await kvGetRaw(prefixedKey);
            const legacyVal = await kvGetRaw(legacyKey);
            const prefixedIdx = parseInt(String(prefixedVal), 10);
            const legacyIdx = parseInt(String(legacyVal), 10);
            let currentKey: string | null = null;
            let currentIdx: number | null = null;
            if (!Number.isNaN(prefixedIdx)) {
                currentKey = prefixedKey;
                currentIdx = prefixedIdx;
            } else if (!Number.isNaN(legacyIdx)) {
                currentKey = legacyKey;
                currentIdx = legacyIdx;
            }

            if (currentKey && currentIdx === optionIdx) {
                await kvDelete(currentKey);
                await kvDelete(currentKey === prefixedKey ? prefixedTsKey : legacyTsKey);
            } else {
                if (currentKey === legacyKey) {
                    await kvDelete(legacyKey);
                    await kvDelete(legacyTsKey);
                }
                const profile = await getSlackProfile(userId);
                await kvSet(prefixedKey, String(optionIdx));
                await kvSet(prefixedTsKey, String(Date.now()));
                await kvSet(`poll:${pollId}:slack_user_name:${userId}`, profile.name || String(slackName));
                if (profile.email) {
                    await kvSet(`poll:${pollId}:slack_user_email:${userId}`, profile.email);
                }
            }

            const slackTs = (await getSlackTsForPoll(pollId)) || ts;
            await updateSlackAndTeams(pollId, meta, channelId, slackTs);
            return new Response('', { status: 200 });
        } catch (error) {
            console.error('Error handling block action:', error);
            return new Response('', { status: 500 });
        }
    }

    // Handle interactive messages (e.g., poll results)
    if (payload.type === 'interactive_message') {
        try {
            const action = payload.actions[0];
            const ts = payload.message.ts;
            const channelId = payload.channel.id;

            if (action.value === 'show_results') {
                const pollId = (await getPollIdBySlackTs(ts)) || ts;
                const meta = await getPollMeta(pollId);
                if (!meta) {
                    console.error('Poll metadata missing or malformed for results:', pollId);
                    return new Response('', { status: 200 });
                }
                const slackTs = (await getSlackTsForPoll(pollId)) || ts;
                await updateSlackAndTeams(pollId, meta, channelId, slackTs);
                return new Response('', { status: 200 });
            }
            return new Response('', { status: 200 }); // No specific action handled
        } catch (error) {
            console.error('Error handling interactive message:', error);
            return new Response('', { status: 500 });
        }
    }

    // Handle other types of interactions if needed
    return new Response('', { status: 200 });
}
