import { renderBar } from '@/domain/render/bar';
import { PollMeta, PollTally, PollVoter } from '@/domain/poll';

function formatSlackVoter(voter: PollVoter) {
    if (voter.ref.startsWith('slack:')) {
        return `<@${voter.ref.slice('slack:'.length)}>`;
    }
    // A Teams voter cannot be @-mentioned from Slack — show their display name.
    return voter.name || voter.ref;
}

export function buildSlackBlocks(meta: PollMeta, tally: PollTally) {
    return [
        {
            type: 'section',
            text: { type: 'mrkdwn', text: `*${meta.question}*` }
        },
        ...meta.options.map((opt, i) => {
            const percent = tally.totalVotes === 0 ? 0 : Math.round((tally.counts[i] / tally.totalVotes) * 100);
            const bar = renderBar(percent, tally.counts[i]);
            const mentions = tally.voters[i].map((voter) => formatSlackVoter(voter)).join(' ');
            return {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `${i + 1}-${opt.label} ${opt.emoji}\n${bar}\n${mentions || '_No votes_'}`
                },
                accessory: {
                    type: 'button',
                    text: { type: 'plain_text', text: `Vote #${i + 1}` },
                    value: `option_${i}`,
                    action_id: `vote_option_${i}`
                }
            };
        }),
        {
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: 'Results: Show in Realtime | :lock: Public: Show Voter Name and Choices' }
            ]
        },
        {
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: `OPEN by system | Responses: ${tally.totalVotes} | Started: <!date^${Math.floor(Date.now() / 1000)}^{date_short} at {time}|Now>` }
            ]
        }
    ];
}
