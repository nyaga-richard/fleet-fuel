'use client';
// Root-level error boundary (catches errors outside route segments too).
export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body style={{ background: '#0b1220', color: '#e6ecf5', fontFamily: 'system-ui, sans-serif', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ maxWidth: 560, textAlign: 'center', padding: 24 }}>
          <h2 style={{ marginBottom: 8 }}>Application error</h2>
          <p style={{ color: '#8fa0b8', marginBottom: 16 }}>
            {String(error?.message || 'Unexpected error')}
          </p>
          <button
            onClick={() => reset()}
            style={{ background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 16px', fontWeight: 600, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
