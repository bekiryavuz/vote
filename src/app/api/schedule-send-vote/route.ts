import { NextRequest, NextResponse } from 'next/server';

async function handle() {
    // Always use relative path for Vercel production
    const res = await fetch('/api/send-vote', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
    });
    const contentType = res.headers.get('content-type') || '';
    let data;
    if (contentType.includes('application/json')) {
        data = await res.json();
    } else {
        const text = await res.text();
        console.error('Non-JSON response from /api/send-vote:', text);
        data = { error: 'Non-JSON response', text };
    }
    if (!res.ok) {
        return NextResponse.json({ error: 'Failed to call /api/send-vote', ...data }, { status: 500 });
    }
    return NextResponse.json(data);
}

export async function GET(req: NextRequest) {
    return handle();
}

export async function POST(req: NextRequest) {
    return handle();
} 