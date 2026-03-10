export type PollOption = {
    label: string;
    emoji: string;
};

export type PollMeta = {
    question: string;
    options: PollOption[];
    creator: string;
};

export type PollTally = {
    counts: number[];
    voters: string[][];
    totalVotes: number;
};

function formatSlackVoter(voter: string) {
    if (voter.startsWith('slack:')) {
        return `<@${voter.replace('slack:', '')}>`;
    }
    if (voter.startsWith('teams:')) {
        return `Teams:${voter.replace('teams:', '')}`;
    }
    return `<@${voter}>`;
}

export function buildPollTally(optionsCount: number, votes: Array<{ voter?: string; optionIdx: number }>): PollTally {
    const counts = Array(optionsCount).fill(0);
    const voters: string[][] = Array.from({ length: optionsCount }, () => []);
    for (const vote of votes) {
        if (vote.optionIdx >= 0 && vote.optionIdx < optionsCount) {
            counts[vote.optionIdx] += 1;
            if (vote.voter) {
                voters[vote.optionIdx].push(vote.voter);
            }
        }
    }
    const totalVotes = counts.reduce((sum, count) => sum + count, 0);
    return { counts, voters, totalVotes };
}

function renderBar(percent: number, count: number, barLength = 10) {
    if (percent <= 0) {
        return `${'░'.repeat(barLength)} 0% (0)`;
    }
    const filled = Math.round(percent / (100 / barLength));
    return `${'▓'.repeat(filled)}${'░'.repeat(barLength - filled)} ${percent}% (${count})`;
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

export function buildTeamsCard(meta: PollMeta, tally: PollTally, pollId: string) {
    const body = [
        { type: 'TextBlock', text: meta.question, weight: 'Bolder', wrap: true },
        ...meta.options.flatMap((opt, i) => {
            const percent = tally.totalVotes === 0 ? 0 : Math.round((tally.counts[i] / tally.totalVotes) * 100);
            const bar = renderBar(percent, tally.counts[i]);
            return [
                { type: 'TextBlock', text: `${i + 1}. ${opt.label} ${opt.emoji}`, wrap: true, spacing: 'Small' },
                { type: 'TextBlock', text: `${bar}`, wrap: true, spacing: 'None' }
            ];
        }),
        { type: 'TextBlock', text: `Responses: ${tally.totalVotes}`, wrap: true, spacing: 'Medium' }
    ];

    const actions = meta.options.map((opt, i) => ({
        type: 'Action.Submit',
        title: `Vote #${i + 1}`,
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

type LegacyOption = { label?: unknown; emoji?: unknown };
type LegacyMeta = { question?: unknown; options?: unknown; creator?: unknown };

function parseLegacyOption(opt: unknown): PollOption | null {
    if (typeof opt === 'string') {
        return { label: opt.toUpperCase(), emoji: opt === 'HOME' ? ':house_with_garden:' : ':office:' };
    }
    if (opt && typeof opt === 'object') {
        const record = opt as LegacyOption;
        const label = typeof record.label === 'string' ? record.label : '';
        const emoji = typeof record.emoji === 'string' ? record.emoji : ':question:';
        return { label: label.toUpperCase(), emoji };
    }
    return null;
}

export function normalizeLegacyMeta(meta: unknown): PollMeta | null {
    if (!meta || typeof meta !== 'object') {
        return null;
    }
    const record = meta as LegacyMeta;
    if (Array.isArray(record.options)) {
        const options = record.options
            .map(parseLegacyOption)
            .filter((opt): opt is PollOption => Boolean(opt));
        return {
            question: typeof record.question === 'string' ? record.question : '',
            options,
            creator: typeof record.creator === 'string' ? record.creator : 'system'
        };
    }
    return null;
}
