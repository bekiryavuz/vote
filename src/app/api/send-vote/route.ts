import { NextRequest, NextResponse } from 'next/server';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID!;
const KV_REST_API_URL = process.env.KV_REST_API_URL!;
const KV_REST_API_TOKEN = process.env.KV_REST_API_TOKEN!;

export async function POST(req: NextRequest) {
    // Only post for Sunday-Thursday (cron handles this)
    const now = new Date();
    if (now.getDay() === 5 || now.getDay() === 6) { // Friday or Saturday
        return NextResponse.json({ ok: false, info: 'Not a valid day to post vote' });
    }
    const next = new Date();
    next.setDate(next.getDate() + 1);
    const dateStr = next.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: '2-digit' });
    const question = `Where will you be working on ${dateStr}?`;
    const options = [
        { emoji: ':house_with_garden:', label: 'HOME' },
        { emoji: ':office:', label: 'OFFICE' }
    ];
    const creator = 'system';

    // Build megavote-style blocks
    const blocks = [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `*${question}*` },
        },
        ...options.map((opt, i) => ({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `${i + 1}-${opt.label} ${opt.emoji}\n░░░░░░░░░░ 0% (0)\n_No votes_`,
            },
            accessory: {
                type: 'button',
                text: { type: 'plain_text', text: `Vote #${i + 1}` },
                value: `option_${i}`,
                action_id: `vote_option_${i}`,
            },
        })),
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
    const slackRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({
            channel: SLACK_CHANNEL_ID,
            blocks,
            text: question,
        }),
    });
    const data = await slackRes.json();
    // Store poll metadata in KV for voting
    if (data.ok) {
        await fetch(`${KV_REST_API_URL}/set/poll:${data.ts}:meta`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${KV_REST_API_TOKEN}` },
            body: JSON.stringify({ question, options, channel: SLACK_CHANNEL_ID, creator }),
        });
    }
    if (!data.ok) {
        return NextResponse.json({ error: data.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, ts: data.ts });
} 