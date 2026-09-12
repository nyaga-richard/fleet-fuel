'use client';
// Route-level error boundary: a client-side exception now shows a friendly,
// recoverable panel instead of Next.js' full-screen "Application error".
export default function Error({ error, reset }) {
  return (
    <div className="card" style={{ maxWidth: 560, margin: '60px auto', textAlign: 'center' }}>
      <h2 style={{ marginBottom: 8 }}>Something went wrong on this page</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        {String(error?.message || 'Unexpected client error')}
      </p>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button className="btn" onClick={() => reset()}>Try again</button>
        <button className="btn secondary" onClick={() => { window.location.href = '/'; }}>Go to dashboard</button>
      </div>
    </div>
  );
}
