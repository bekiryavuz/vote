import { NextRequest, NextResponse } from 'next/server';
import { slack } from '@/composition';

export async function POST(req: NextRequest) {
    const body = await req.text();
    const params = new URLSearchParams(body);
    const triggerId = params.get('trigger_id');
    const channelId = params.get('channel_id');

    if (!triggerId) {
        return NextResponse.json({ ok: false, error: 'Missing trigger_id' }, { status: 400 });
    }

    const result = await slack.openCreateModal(triggerId, channelId);
    if (!result.ok) {
        return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
    }
    return new Response('', { status: 200 });
}
