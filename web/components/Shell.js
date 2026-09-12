'use client';
// Application shell: sidebar navigation + auth guard + user box.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';

const NAV = [
  { group: 'Overview', links: [
    { href: '/', label: 'Dashboard', roles: ['admin', 'manager', 'attendant'] },
    { href: '/ledger', label: 'Fuel Ledger', roles: ['admin', 'manager', 'attendant'] },
  ]},
  { group: 'Operations', links: [
    { href: '/requests', label: 'Fuel Requests', roles: ['admin', 'manager', 'attendant'] },
    { href: '/issue', label: 'Issue Fuel', roles: ['admin', 'manager', 'attendant'] },
    { href: '/inventory', label: 'Inventory', roles: ['admin', 'manager', 'attendant'] },
  ]},
  { group: 'Administration', links: [
    { href: '/vehicles', label: 'Vehicles', roles: ['admin', 'manager', 'attendant'] },
    { href: '/configuration', label: 'Configuration', roles: ['admin', 'manager'] },
    { href: '/users', label: 'Users', roles: ['admin'] },
    { href: '/system', label: 'System', roles: ['admin', 'manager', 'attendant'] },
  ]},
];

export default function Shell({ children }) {
  const { user, ready, logout } = useAuth();
  const pathname = usePathname();
  if (!ready) return <div className="login-wrap"><p className="muted">Loading…</p></div>;
  if (!user) return null; // redirecting to /login
  if (!user.id || !user.role) {
    // Corrupt/stale cached profile (e.g. from an older schema) — sign out cleanly.
    logout();
    return <div className="login-wrap"><p className="muted">Session refreshed — signing in again…</p></div>;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          Fleet Fuel
          <small>Fuel Management System</small>
        </div>
        <nav className="nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.links.filter((l) => l.roles.includes(user.role)).map((l) => (
                <Link key={l.href} href={l.href} className={pathname === l.href ? 'active' : ''}>
                  {l.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="main">
        <div className="page-head">
          <h1>{currentTitle(NAV, pathname)}</h1>
          <div className="userbox">
            <b>{user.name}</b>
            {user.email} · <span style={{ textTransform: 'capitalize' }}>{user.role}</span>
            <div><button className="btn secondary sm" onClick={logout}>Sign out</button></div>
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}

function currentTitle(nav, path) {
  for (const g of nav) {
    for (const l of g.links) {
      if (l.href === path) return l.label;
    }
  }
  return 'Fleet Fuel';
}
