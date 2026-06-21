// Pure poll domain: types, tally aggregation, legacy normalization. No I/O.

export type PollOption = {
    label: string;
    emoji: string;
};

export type PollMeta = {
    question: string;
    options: PollOption[];
    creator: string;
};

export type PollVoter = {
    ref: string;
    name: string;
};

export type PollTally = {
    counts: number[];
    voters: PollVoter[][];
    totalVotes: number;
};

const HOME_EMOJI = ':house_with_garden:';
const OFFICE_EMOJI = ':office:';
const FALLBACK_EMOJI = ':grey_question:';

// Single source of truth for the HOME/OFFICE/other emoji mapping used when a poll is
// created from free-text option labels (Slack modal + scheduled cron share this).
export function optionFromLabel(rawLabel: string): PollOption {
    const label = rawLabel.toUpperCase();
    const emoji = label === 'HOME' ? HOME_EMOJI : label === 'OFFICE' ? OFFICE_EMOJI : FALLBACK_EMOJI;
    return { label, emoji };
}

export function buildPollTally(
    optionsCount: number,
    votes: Array<{ ref?: string; name?: string; optionIdx: number }>
): PollTally {
    const counts = Array(optionsCount).fill(0);
    const voters: PollVoter[][] = Array.from({ length: optionsCount }, () => []);
    for (const vote of votes) {
        if (vote.optionIdx >= 0 && vote.optionIdx < optionsCount) {
            counts[vote.optionIdx] += 1;
            if (vote.ref || vote.name) {
                voters[vote.optionIdx].push({ ref: vote.ref ?? '', name: vote.name ?? '' });
            }
        }
    }
    const totalVotes = counts.reduce((sum, count) => sum + count, 0);
    return { counts, voters, totalVotes };
}

type LegacyOption = { label?: unknown; emoji?: unknown };
type LegacyMeta = { question?: unknown; options?: unknown; creator?: unknown };

function parseLegacyOption(opt: unknown): PollOption | null {
    if (typeof opt === 'string') {
        return { label: opt.toUpperCase(), emoji: opt === 'HOME' ? HOME_EMOJI : OFFICE_EMOJI };
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
