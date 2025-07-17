import { NextRequest, NextResponse } from 'next/server';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const KV_REST_API_URL = process.env.KV_REST_API_URL!;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN!;

// Helper function to render a poll option (for both initial and update)
function renderPollOption({
    index,
    label,
    emoji,
    bar,
    mentions,
    hasVotes
}: {
    index: number,
    label: string,
    emoji: string,
    bar: string,
    mentions?: string,
    hasVotes?: boolean
}) {
    return {
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: `*${index}-${label} ${emoji}*\n${bar}` + (mentions ? `\n${mentions}` : '\n_No votes_'),
        },
        accessory: {
            type: 'button',
            text: { type: 'plain_text', text: `Vote #${index}` },
            value: `option_${index - 1}`,
            action_id: `vote_option_${index - 1}`
        }
    };
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

        // Build megavote-style blocks
        const blocks = [
            {
                type: 'section',
                text: { type: 'mrkdwn', text: `*${question}*` },
            },
            ...options.map((opt: string, i: number) => {
                // For both initial and update logic, use 10 blocks for the bar
                const barLength = 10;
                const bar = '░'.repeat(barLength) + ' 0% (0)';
                return [
                    renderPollOption({
                        index: i + 1,
                        label: opt.toUpperCase(),
                        emoji: opt === 'HOME' ? ':house_with_garden:' : ':office:',
                        bar,
                        mentions: undefined,
                        hasVotes: false
                    }),
                    { type: 'section', text: { type: 'plain_text', text: ' ' } },
                    { type: 'section', text: { type: 'plain_text', text: ' ' } }
                ];
            }).flat(),
            {
                type: 'context',
                elements: [
                    { type: 'mrkdwn', text: `Results: Show in Realtime | :lock: Public: Show Voter Name and Choices` },
                ],
            },
            {
                type: 'context',
                elements: [
                    { type: 'mrkdwn', text: `OPEN by system | Responses: -- | Started: <!date^${Math.floor(Date.now() / 1000)}^{date_short} at {time}|Now>` },
                ],
            },
        ];

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
            await fetch(`${KV_REST_API_URL}/set/poll:${postData.ts}:meta`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
                body: JSON.stringify({ question, options, channel: channelId, creator: userId }),
            });
        }
        // Respond with 200 OK and empty body
        return new Response('', { status: 200 });
    }

    // Handle voting button clicks (block actions)
    if (payload.type === 'block_actions') {
        try {
            // Get poll info
            const action = payload.actions[0];
            const userId = payload.user.id;
            const optionIdx = parseInt(action.value.replace('option_', ''));
            const ts = payload.message.ts;
            const channelId = payload.channel.id;
            // Get poll metadata
            const metaRes = await fetch(`${KV_REST_API_URL}/get/poll:${ts}:meta`, {
                headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
            });
            const metaText = await metaRes.text();
            let meta;
            try {
                meta = JSON.parse(metaText);
                if (meta && typeof meta.result === 'string') {
                    meta = JSON.parse(meta.result);
                }
            } catch {
                console.error('Failed to parse poll metadata:', metaText);
                return new Response('', { status: 200 });
            }
            if (!meta || !Array.isArray(meta.options)) {
                console.error('Poll metadata missing or malformed:', meta);
                return new Response('', { status: 200 });
            }
            // Check if user is toggling their vote
            const userVoteKey = `poll:${ts}:vote:${userId}`;
            let currentVoteVal = null;
            try {
                const currentVoteRes = await fetch(`${KV_REST_API_URL}/get/${userVoteKey}`, {
                    headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
                });
                const currentVoteText = await currentVoteRes.text();
                try {
                    const parsed = JSON.parse(currentVoteText);
                    currentVoteVal = parseInt(parsed.result);
                } catch {
                    currentVoteVal = parseInt(currentVoteText);
                }
            } catch { }
            if (currentVoteVal === optionIdx) {
                // User clicked their current vote, remove it
                await fetch(`${KV_REST_API_URL}/del/${userVoteKey}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
                });
                console.log('Vote removed:', userVoteKey);
            } else {
                // Store the user's vote
                await fetch(`${KV_REST_API_URL}/set/${userVoteKey}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
                    body: String(optionIdx),
                });
                console.log('Vote written:', `${userVoteKey} = ${optionIdx}`);
            }
            // Get all votes
            const votesRes = await fetch(`${KV_REST_API_URL}/keys/poll:${ts}:vote:*`, {
                headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
            });
            let voteKeys = [];
            try {
                voteKeys = await votesRes.json();
                if (voteKeys && Array.isArray(voteKeys.result)) {
                    voteKeys = voteKeys.result;
                }
                console.log('Vote keys found:', voteKeys);
            } catch { }
            // Tally votes
            const counts: number[] = Array(meta.options.length).fill(0);
            const voters: string[][] = Array(meta.options.length).fill(0).map(() => []);
            for (const key of voteKeys) {
                const uid = key.split(':').pop();
                const vRes = await fetch(`${KV_REST_API_URL}/get/${key}`, {
                    headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
                });
                const val = await vRes.text();
                console.log('Vote value for', key, '=', val);
                let idx;
                try {
                    const parsed = JSON.parse(val);
                    idx = parseInt(parsed.result);
                } catch {
                    idx = parseInt(val);
                }
                if (!isNaN(idx) && idx >= 0 && idx < meta.options.length) {
                    counts[idx]++;
                    voters[idx].push(uid);
                }
            }
            const totalVotes = counts.reduce((a, b) => a + b, 0);
            // Build updated blocks
            const blocks = [
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: `*${meta.question}*` },
                },
                ...meta.options.map((opt: { label?: string; emoji?: string } | string, i: number) => {
                    let label = '', emoji = '';
                    if (typeof opt === 'object' && opt !== null && 'label' in opt && 'emoji' in opt) {
                        label = opt.label!;
                        emoji = opt.emoji!;
                    } else if (typeof opt === 'string') {
                        // fallback for old polls
                        label = opt.toUpperCase();
                        emoji = opt === 'HOME' ? ':house_with_garden:' : ':office:';
                    }
                    // For initial state, use bar as ░░░░░░░░░░ 0% (0) and _No votes_
                    const percent = totalVotes === 0 ? 0 : Math.round((counts[i] / totalVotes) * 100);
                    // In update logic:
                    const barLength = 10;
                    const filled = Math.round(percent / (100 / barLength));
                    const bar = percent === 0 ? '░'.repeat(barLength) + ' 0% (0)' : `${'▓'.repeat(filled)}${'░'.repeat(barLength - filled)} ${percent}% (${counts[i]})`;
                    const mentions = voters[i].map(uid => `<@${uid}>`).join(' ');
                    return {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `${i + 1}-${label} ${emoji}\n${bar}\n${mentions || '_No votes_'}`,
                        },
                        accessory: {
                            type: 'button',
                            text: { type: 'plain_text', text: `Vote #${i + 1}` },
                            value: `option_${i}`,
                            action_id: `vote_option_${i}`,
                        },
                    };
                }),
                {
                    type: 'context',
                    elements: [
                        { type: 'mrkdwn', text: `Results: Show in Realtime | :lock: Public: Show Voter Name and Choices` },
                    ],
                },
                {
                    type: 'context',
                    elements: [
                        { type: 'mrkdwn', text: `OPEN by system | Responses: ${totalVotes} | Started: <!date^${Math.floor(Date.now() / 1000)}^{date_short} at {time}|Now>` },
                    ],
                },
            ];

            // Update the original message
            const updateRes = await fetch(`https://slack.com/api/chat.update`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
                },
                body: JSON.stringify({
                    channel: channelId,
                    ts: payload.message.ts,
                    blocks,
                }),
            });
            const updateData = await updateRes.json();
            if (updateData.ok) {
                console.log('Poll updated successfully');
                return new Response('', { status: 200 });
            } else {
                console.error('Failed to update poll:', updateData.error);
                return new Response('', { status: 500 });
            }
        } catch (error) {
            console.error('Error handling block action:', error);
            return new Response('', { status: 500 });
        }
    }

    // Handle interactive messages (e.g., poll results)
    if (payload.type === 'interactive_message') {
        try {
            const action = payload.actions[0];
            const userId = payload.user.id;
            const ts = payload.message.ts;
            const channelId = payload.channel.id;

            if (action.value === 'show_results') {
                // Get poll metadata
                const metaRes = await fetch(`${KV_REST_API_URL}/get/poll:${ts}:meta`, {
                    headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
                });
                const metaText = await metaRes.text();
                let meta;
                try {
                    meta = JSON.parse(metaText);
                    if (meta && typeof meta.result === 'string') {
                        meta = JSON.parse(meta.result);
                    }
                } catch {
                    console.error('Failed to parse poll metadata for results:', metaText);
                    return new Response('', { status: 200 });
                }
                if (!meta || !Array.isArray(meta.options)) {
                    console.error('Poll metadata missing or malformed for results:', meta);
                    return new Response('', { status: 200 });
                }

                // Get all votes
                const votesRes = await fetch(`${KV_REST_API_URL}/keys/poll:${ts}:vote:*`, {
                    headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
                });
                let voteKeys = [];
                try {
                    voteKeys = await votesRes.json();
                    if (voteKeys && Array.isArray(voteKeys.result)) {
                        voteKeys = voteKeys.result;
                    }
                    console.log('Vote keys found for results:', voteKeys);
                } catch { }

                // Tally votes
                const counts: number[] = Array(meta.options.length).fill(0);
                const voters: string[][] = Array(meta.options.length).fill(0).map(() => []);
                for (const key of voteKeys) {
                    const uid = key.split(':').pop();
                    const vRes = await fetch(`${KV_REST_API_URL}/get/${key}`, {
                        headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
                    });
                    const val = await vRes.text();
                    console.log('Vote value for', key, '=', val);
                    let idx;
                    try {
                        const parsed = JSON.parse(val);
                        idx = parseInt(parsed.result);
                    } catch {
                        idx = parseInt(val);
                    }
                    if (!isNaN(idx) && idx >= 0 && idx < meta.options.length) {
                        counts[idx]++;
                        voters[idx].push(uid);
                    }
                }
                const totalVotes = counts.reduce((a, b) => a + b, 0);

                // Build results blocks
                const resultsBlocks = [
                    {
                        type: 'section',
                        text: { type: 'mrkdwn', text: `*${meta.question}*` },
                    },
                    ...meta.options.map((opt: { label?: string; emoji?: string } | string, i: number) => {
                        let label = '', emoji = '';
                        if (typeof opt === 'object' && opt !== null && 'label' in opt && 'emoji' in opt) {
                            label = opt.label!;
                            emoji = opt.emoji!;
                        } else if (typeof opt === 'string') {
                            // fallback for old polls
                            label = opt.toUpperCase();
                            emoji = opt === 'HOME' ? ':house_with_garden:' : ':office:';
                        }
                        const percent = totalVotes === 0 ? 0 : Math.round((counts[i] / totalVotes) * 100);
                        const barLength = 10;
                        const filled = Math.round(percent / (100 / barLength));
                        const bar = percent === 0 ? '░'.repeat(barLength) + ' 0% (0)' : `${'🟩'.repeat(filled)}${'░'.repeat(barLength - filled)} ${percent}% (${counts[i]})`;
                        const mentions = voters[i].map(uid => `<@${uid}>`).join(' ');
                        return {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: `${i + 1}-${label} ${emoji}\n${bar}\n${mentions || '_No votes_'}`,
                            },
                            accessory: {
                                type: 'button',
                                text: { type: 'plain_text', text: `Vote #${i + 1}` },
                                value: `option_${i}`,
                                action_id: `vote_option_${i}`,
                            },
                        };
                    }),
                    {
                        type: 'context',
                        elements: [
                            { type: 'mrkdwn', text: `Results: Show in Realtime | :lock: Public: Show Voter Name and Choices` },
                        ],
                    },
                    {
                        type: 'context',
                        elements: [
                            { type: 'mrkdwn', text: `OPEN by system | Responses: ${totalVotes} | Started: <!date^${Math.floor(Date.now() / 1000)}^{date_short} at {time}|Now>` },
                        ],
                    },
                ];

                // Update the original message with results
                const updateRes = await fetch(`https://slack.com/api/chat.update`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
                    },
                    body: JSON.stringify({
                        channel: channelId,
                        ts: payload.message.ts,
                        blocks: resultsBlocks,
                    }),
                });
                const updateData = await updateRes.json();
                if (updateData.ok) {
                    console.log('Poll results updated successfully');
                    return new Response('', { status: 200 });
                } else {
                    console.error('Failed to update poll results:', updateData.error);
                    return new Response('', { status: 500 });
                }
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