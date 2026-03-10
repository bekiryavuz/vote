import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { buildPollTally, buildSlackBlocks, PollMeta } from '@/lib/poll';
import { kvSet } from '@/lib/kv';
import { resolveTeamsConversationReference, sendTeamsPoll, teamsBotConfigReady } from '@/lib/teams';

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID!;

export async function POST() {
    // Only post for Sunday-Friday (block Saturday)
    const now = new Date();
    if (now.getDay() === 6) { // Saturday
        return NextResponse.json({ ok: false, info: 'Not a valid day to post vote' });
    }
    const next = new Date();
    if (now.getDay() === 5) { // Friday
        next.setDate(next.getDate() + 3); // Next workday is Monday
    } else {
        next.setDate(next.getDate() + 1); // Next day
    }
    const dateStr = next.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: '2-digit' });
    const question = `Where will you be working on ${dateStr}?`;
    const options = [
        { emoji: ':house_with_garden:', label: 'HOME' },
        { emoji: ':office:', label: 'OFFICE' }
    ];
    const creator = 'system';
    const pollId = randomUUID();
    const meta: PollMeta = { question, options, creator };
    const tally = buildPollTally(options.length, []);
    const blocks = buildSlackBlocks(meta, tally);

    // Post the poll to the Slack channel
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
    if (!data.ok) {
        return NextResponse.json({ error: data.error }, { status: 500 });
    }
    await kvSet(`poll:${pollId}:meta`, meta);
    await kvSet(`poll:${pollId}:slack_ts`, data.ts);
    await kvSet(`poll:${pollId}:slack_channel_id`, SLACK_CHANNEL_ID);
    await kvSet(`poll:slack_ts:${data.ts}`, pollId);

    let teamsActivityId: string | null = null;
    let teamsError: string | null = null;
    if (teamsBotConfigReady()) {
        try {
            const resolved = await resolveTeamsConversationReference();
            if (!resolved) {
                teamsError = 'Teams conversation reference missing';
            } else {
                await kvSet(`poll:${pollId}:teams_ref_key`, resolved.key);
                teamsActivityId = await sendTeamsPoll(pollId, meta, tally, resolved.reference);
                if (teamsActivityId) {
                    await kvSet(`poll:${pollId}:teams_activity_id`, teamsActivityId);
                } else {
                    teamsError = 'Teams activity id missing';
                }
            }
        } catch {
            teamsError = 'Teams send failed';
        }
    }

    return NextResponse.json({ ok: true, poll_id: pollId, slack_ts: data.ts, teams_activity_id: teamsActivityId, teams_error: teamsError });
} 
