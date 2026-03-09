export const metadata = {
    title: 'Terms of Use',
};

export default function TermsPage() {
    return (
        <main style={{ maxWidth: 760, margin: '40px auto', padding: '0 16px', lineHeight: 1.6 }}>
            <h1>Terms of Use</h1>
            <p>Last updated: March 9, 2026</p>
            <p>
                This application is provided for internal workplace polling. By using it, users agree that submitted
                votes are visible to participants as configured in Slack and Microsoft Teams.
            </p>
            <p>
                Users must not abuse, disrupt, or attempt to tamper with bot actions, scheduled jobs, or synchronization
                mechanisms.
            </p>
            <p>
                The service is provided as-is for organizational use. Availability and behavior may change without prior
                notice.
            </p>
            <p>
                For operational issues or takedown requests, contact Pavza Bilisim through official support channels.
            </p>
        </main>
    );
}
