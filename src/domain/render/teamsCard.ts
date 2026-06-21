import { renderBar } from '@/domain/render/bar';
import { PollMeta, PollTally, PollVoter } from '@/domain/poll';

function toTeamsEmoji(emojiCode: string) {
    const normalized = emojiCode.trim().toLowerCase();
    if (normalized === ':house_with_garden:') {
        return '🏡';
    }
    if (normalized === ':office:') {
        return '🏢';
    }
    if (normalized === ':grey_question:') {
        return '❔';
    }
    if (normalized.startsWith(':') && normalized.endsWith(':')) {
        return normalized.slice(1, -1).replaceAll('_', ' ');
    }
    return normalized;
}

function formatTeamsVoter(voter: PollVoter) {
    return voter.name || voter.ref;
}

export function buildTeamsCard(meta: PollMeta, tally: PollTally, pollId: string) {
    const body = [
        { type: 'TextBlock', text: meta.question, weight: 'Bolder', wrap: true },
        ...meta.options.flatMap((opt, i) => {
            const percent = tally.totalVotes === 0 ? 0 : Math.round((tally.counts[i] / tally.totalVotes) * 100);
            const bar = renderBar(percent, tally.counts[i]);
            const emoji = toTeamsEmoji(opt.emoji);
            const voters = tally.voters[i].map((voter) => formatTeamsVoter(voter)).filter(Boolean).join(', ');
            return [
                { type: 'TextBlock', text: `${i + 1}. ${opt.label} ${emoji}`, wrap: true, spacing: 'Small' },
                { type: 'TextBlock', text: `${bar}`, wrap: true, spacing: 'None' },
                { type: 'TextBlock', text: voters || '_No votes_', wrap: true, spacing: 'None', size: 'Small', isSubtle: true }
            ];
        }),
        { type: 'TextBlock', text: `Responses: ${tally.totalVotes}`, wrap: true, spacing: 'Medium' }
    ];

    const actions = meta.options.map((opt, i) => ({
        type: 'Action.Submit',
        title: `${toTeamsEmoji(opt.emoji)} ${opt.label}`,
        data: { pollId, optionIdx: i }
    }));

    return {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body,
        actions
    };
}
