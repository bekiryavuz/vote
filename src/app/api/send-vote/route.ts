import { NextResponse } from 'next/server';
import { buildScheduledPoll } from '@/application/scheduledPoll';
import { createScheduledPoll } from '@/composition';

export async function POST() {
    const scheduled = buildScheduledPoll();
    if (scheduled.skip) {
        return NextResponse.json({ ok: false, info: 'Not a valid day to post vote' });
    }
    const result = await createScheduledPoll(scheduled);
    if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({
        ok: true,
        poll_id: result.pollId,
        slack_ts: result.slackTs,
        teams_activity_id: result.teamsActivityId,
        teams_error: result.teamsError
    });
}
