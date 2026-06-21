// Pure ASCII progress-bar renderer shared by the Slack and Teams views.

export function renderBar(percent: number, count: number, barLength = 10) {
    if (percent <= 0) {
        return `${'░'.repeat(barLength)} 0% (0)`;
    }
    const filled = Math.round(percent / (100 / barLength));
    return `${'▓'.repeat(filled)}${'░'.repeat(barLength - filled)} ${percent}% (${count})`;
}
