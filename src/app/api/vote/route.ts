import { NextRequest, NextResponse } from 'next/server';

const KV_REST_API_URL = process.env.KV_REST_API_URL!;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN!;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;

async function updateVote(ts: string, user: string, vote: string) {
    // Update vote in KV
    await fetch(`${KV_REST_API_URL}/set/vote:${ts}:${user}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
        body: vote,
    });
}

async function getVotesWithUsers(ts: string) {
    // Get all votes for this message
    const res = await fetch(`${KV_REST_API_URL}/keys/vote:${ts}:*`, {
        headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
    });
    let keys;
    try {
        keys = await res.json();
    } catch (e) {
        keys = [];
    }
    if (!Array.isArray(keys)) {
        keys = [];
    }
    const home: string[] = [], office: string[] = [];
    for (const key of keys) {
        const userId = key.split(':').pop();
        const v = await fetch(`${KV_REST_API_URL}/get/${key}`,
            { headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` } });
        const val = await v.text();
        if (val === 'home') home.push(userId);
        if (val === 'office') office.push(userId);
    }
    return { home, office };
}

async function getSlackDisplayName(userId: string) {
    const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    const data = await res.json();
    if (data.ok) {
        return data.user.profile.display_name || data.user.real_name || userId;
    }
    return userId;
}

export async function POST(req: NextRequest) {
    try {
        let form: FormData;
        try {
            form = await req.formData();
        } catch (e) {
            return NextResponse.json({ ok: true, info: 'No form data, health check or verification' });
        }
        const payloadRaw = form.get('payload');
        if (!payloadRaw) {
            return NextResponse.json({ ok: true, info: 'No payload, health check or verification' });
        }
        let payload;
        try {
            payload = JSON.parse(payloadRaw as string);
        } catch (e) {
            return NextResponse.json({ ok: false, error: 'Invalid payload JSON' }, { status: 400 });
        }
        const { user, actions, message } = payload;
        if (!user || !actions || !message) {
            return NextResponse.json({ ok: false, error: 'Missing required fields in payload' }, { status: 400 });
        }
        const vote = actions[0].value;
        const ts = message.ts;
        await updateVote(ts, user.id, vote);
        const votes = await getVotesWithUsers(ts);

        // Fetch display names for each voter
        const homeNames = await Promise.all(votes.home.map(getSlackDisplayName));
        const officeNames = await Promise.all(votes.office.map(getSlackDisplayName));

        // Calculate vote stats
        const totalVotes = homeNames.length + officeNames.length;
        function getPercent(count: number) {
            return totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100);
        }
        function getBar(percent: number) {
            // 10 blocks, filled with █, empty with ░
            const filled = Math.round(percent / 10);
            return '█'.repeat(filled) + '░'.repeat(10 - filled);
        }
        // Build Slack mentions
        const homeMentions = votes.home.map(id => `<@${id}>`).join(' ');
        const officeMentions = votes.office.map(id => `<@${id}>`).join(' ');
        // Update Slack message
        const text = message.blocks[0].text.text;
        const blocks = [
            { type: 'section', text: { type: 'mrkdwn', text } },
            message.blocks[1], // actions block (the buttons)
            ...[{
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `1-HOME :house_with_garden:\n░░░░░░░░░░ 0% (0)\n${homeMentions || '_No votes_'} `,
                },
                accessory: {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Vote #1' },
                    value: 'option_0',
                    action_id: 'vote_option_0',
                },
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `2-OFFICE :office:\n░░░░░░░░░░ 0% (0)\n${officeMentions || '_No votes_'} `,
                },
                accessory: {
                    type: 'button',
                    text: { type: 'plain_text', text: 'Vote #2' },
                    value: 'option_1',
                    action_id: 'vote_option_1',
                },
            }],
            {
                type: 'context',
                elements: [
                    { type: 'mrkdwn', text: 'Results: Show in Realtime | :lock: Public: Show Voter Name and Choices' },
                ],
            },
            {
                type: 'context',
                elements: [
                    { type: 'mrkdwn', text: `OPEN by system | Responses: -- | Started: <!date^${Math.floor(Date.now() / 1000)}^{date_short} at {time}|Now>` },
                ],
            },
        ];
        await fetch('https://slack.com/api/chat.update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            },
            body: JSON.stringify({
                channel: message.channel,
                ts,
                text,
                blocks,
            }),
        });

        return NextResponse.json({ ok: true });
    } catch (error) {
        console.error('Error in /api/vote:', error);
        return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
    }
} 