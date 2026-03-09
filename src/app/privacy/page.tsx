export const metadata = {
    title: 'Privacy Policy',
};

export default function PrivacyPage() {
    return (
        <main style={{ maxWidth: 760, margin: '40px auto', padding: '0 16px', lineHeight: 1.6 }}>
            <h1>Privacy Policy</h1>
            <p>Last updated: March 9, 2026</p>
            <p>
                This application collects and processes voting interaction data required to run workplace attendance
                polls in Slack and Microsoft Teams.
            </p>
            <p>
                Data may include user identifiers, selected poll option, poll timestamps, and channel metadata required
                for real-time synchronization.
            </p>
            <p>
                The data is used only for poll functionality, message updates, and operational debugging. It is not sold
                to third parties.
            </p>
            <p>
                For support requests, please contact Pavza Bilisim through the official company channels.
            </p>
        </main>
    );
}
