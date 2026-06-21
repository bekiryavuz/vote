import { PollOption } from '@/domain/poll';

// Pure scheduling rules for the daily cron poll: skip Saturdays, otherwise ask about the
// next workday (Friday rolls to Monday).
export type ScheduledPoll =
    | { skip: true }
    | { skip?: false; question: string; options: PollOption[]; creator: string };

export function buildScheduledPoll(now: Date = new Date()): ScheduledPoll {
    if (now.getDay() === 6) {
        return { skip: true };
    }
    const next = new Date(now);
    if (now.getDay() === 5) {
        next.setDate(next.getDate() + 3); // Friday -> Monday
    } else {
        next.setDate(next.getDate() + 1);
    }
    const dateStr = next.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: '2-digit' });
    return {
        question: `Where will you be working on ${dateStr}?`,
        options: [
            { emoji: ':house_with_garden:', label: 'HOME' },
            { emoji: ':office:', label: 'OFFICE' }
        ],
        creator: 'system'
    };
}
