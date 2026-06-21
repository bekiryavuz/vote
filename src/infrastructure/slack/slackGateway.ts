import { config } from '@/infrastructure/config';
import type { SlackGateway } from '@/application/ports';

const SLACK_API = 'https://slack.com/api';

function jsonHeaders() {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${config.slack.botToken}` };
}

function buildCreateModalView(channelId: string | null) {
    return {
        type: 'modal',
        callback_id: 'create_vote_modal',
        title: { type: 'plain_text', text: 'Post New Vote' },
        submit: { type: 'plain_text', text: 'Submit' },
        close: { type: 'plain_text', text: 'Cancel' },
        private_metadata: channelId ?? '',
        blocks: [
            {
                type: 'input',
                block_id: 'question',
                label: { type: 'plain_text', text: 'Question' },
                element: {
                    type: 'plain_text_input',
                    action_id: 'question_input',
                    placeholder: { type: 'plain_text', text: 'Enter your question, support format/emoji...' }
                }
            },
            {
                type: 'input',
                block_id: 'options',
                label: { type: 'plain_text', text: 'Options' },
                element: {
                    type: 'plain_text_input',
                    action_id: 'options_input',
                    multiline: true,
                    placeholder: { type: 'plain_text', text: 'One option per line. Support format/emoji...' }
                }
            }
        ]
    };
}

export function createSlackGateway(): SlackGateway {
    return {
        async postPoll(channel, blocks, text) {
            const res = await fetch(`${SLACK_API}/chat.postMessage`, {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({ channel, blocks, text })
            });
            const data = await res.json().catch(() => null);
            return { ok: Boolean(data?.ok), ts: data?.ts, error: data?.error };
        },

        async updatePoll(channel, ts, blocks) {
            const res = await fetch(`${SLACK_API}/chat.update`, {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({ channel, ts, blocks })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.ok) {
                console.error('Failed to update Slack poll', { ts, status: res.status, slackError: data?.error });
            }
            return { ok: Boolean(data?.ok), error: data?.error };
        },

        async openCreateModal(triggerId, channelId) {
            const res = await fetch(`${SLACK_API}/views.open`, {
                method: 'POST',
                headers: jsonHeaders(),
                body: JSON.stringify({ trigger_id: triggerId, view: buildCreateModalView(channelId) })
            });
            const data = await res.json().catch(() => null);
            return { ok: Boolean(data?.ok), error: data?.error };
        },

        async getProfile(userId) {
            try {
                const res = await fetch(`${SLACK_API}/users.info?user=${userId}`, {
                    headers: { Authorization: `Bearer ${config.slack.botToken}` }
                });
                const data = await res.json();
                if (data.ok) {
                    const profile = data.user?.profile ?? {};
                    const name = profile.real_name || data.user?.real_name || profile.display_name || '';
                    const email = profile.email || '';
                    return { name, email };
                }
                // Most commonly error === 'missing_scope': add users:read (+ users:read.email)
                // to the Slack app's bot token scopes so real names / emails resolve.
                console.error('Slack users.info failed; falling back to handle', { error: data?.error });
            } catch (error) {
                console.error('Slack users.info threw', { userId, error });
            }
            return { name: '', email: '' };
        }
    };
}
