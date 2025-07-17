import { NextRequest, NextResponse } from 'next/server';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;

export async function POST(req: NextRequest) {
    // Parse the x-www-form-urlencoded body
    const body = await req.text();
    const params = new URLSearchParams(body);
    const trigger_id = params.get('trigger_id');
    const user_id = params.get('user_id');
    const channel_id = params.get('channel_id');

    if (!trigger_id) {
        return NextResponse.json({ ok: false, error: 'Missing trigger_id' }, { status: 400 });
    }

    // Build the modal view
    const view = {
        type: 'modal',
        callback_id: 'create_vote_modal',
        title: { type: 'plain_text', text: 'Post New Vote' },
        submit: { type: 'plain_text', text: 'Submit' },
        close: { type: 'plain_text', text: 'Cancel' },
        private_metadata: channel_id, // Pass channel_id for later use
        blocks: [
            {
                type: 'input',
                block_id: 'question',
                label: { type: 'plain_text', text: 'Question' },
                element: {
                    type: 'plain_text_input',
                    action_id: 'question_input',
                    placeholder: { type: 'plain_text', text: 'Enter your question, support format/emoji...' },
                },
            },
            {
                type: 'input',
                block_id: 'options',
                label: { type: 'plain_text', text: 'Options' },
                element: {
                    type: 'plain_text_input',
                    action_id: 'options_input',
                    multiline: true,
                    placeholder: { type: 'plain_text', text: 'One option per line. Support format/emoji...' },
                },
            },
        ],
    };

    // Open the modal using Slack API
    const slackRes = await fetch('https://slack.com/api/views.open', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({
            trigger_id,
            view,
        }),
    });
    const data = await slackRes.json();
    if (!data.ok) {
        return NextResponse.json({ ok: false, error: data.error }, { status: 500 });
    }

    // Respond to Slack with 200 OK (empty body)
    return new Response('', { status: 200 });
} 