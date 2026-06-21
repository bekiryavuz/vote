import { NextRequest } from 'next/server';
import { createPollFromModal, recordSlackVote, repo, syncPoll } from '@/composition';

export async function POST(req: NextRequest) {
    const form = await req.formData();
    const payload = JSON.parse(form.get('payload') as string);

    // Create-poll modal submitted
    if (payload.type === 'view_submission' && payload.view.callback_id === 'create_vote_modal') {
        await createPollFromModal({
            question: payload.view.state.values.question.question_input.value,
            optionsRaw: payload.view.state.values.options.options_input.value,
            userId: payload.user.id,
            channelId: payload.view.private_metadata || null
        });
        return new Response('', { status: 200 });
    }

    // Vote button clicked
    if (payload.type === 'block_actions') {
        try {
            const action = payload.actions[0];
            await recordSlackVote({
                userId: payload.user.id,
                slackHandle: payload.user?.name || payload.user?.username || payload.user.id,
                optionIdx: parseInt(action.value.replace('option_', '')),
                ts: payload.message.ts,
                channelId: payload.channel.id
            });
            return new Response('', { status: 200 });
        } catch (error) {
            console.error('Error handling block action:', error);
            return new Response('', { status: 500 });
        }
    }

    // Legacy "show results" interactive message
    if (payload.type === 'interactive_message') {
        try {
            const action = payload.actions[0];
            if (action.value === 'show_results') {
                const ts = payload.message.ts;
                const pollId = (await repo.getPollIdBySlackTs(ts)) || ts;
                const meta = await repo.getMeta(pollId);
                if (meta) {
                    await syncPoll(pollId, meta, { channelId: payload.channel.id, ts });
                }
            }
            return new Response('', { status: 200 });
        } catch (error) {
            console.error('Error handling interactive message:', error);
            return new Response('', { status: 500 });
        }
    }

    return new Response('', { status: 200 });
}
