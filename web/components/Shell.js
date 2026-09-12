'use client';
// ─────────────────────────────────────────────────────────────────────────────
// Application shell — header (search · alerts · user) + sidebar + content.
//
// • Sidebar collapsible (persisted), auto-drawer under 940px
// • Global search across vehicles / requests / transactions (debounced,
//   server-backed where the API supports it — no mock data)
// • Pending-approvals alert for managers/admins
// • Auth gate: children only render when the shared auth context has a user
// ─────────────────────────────────────────────────────────────────────────────
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { api } from '@/lib/api';

const NAV = [
  { group: 'Overview', links: [
    { href: '/', label: 'Dashboard', roles: ['admin', 'manager', 'attendant'], icon: 'dash' },
    { href: '/ledger', label: 'Fuel Ledger', roles: ['admin', 'manager', 'attendant'], icon: 'book' },
  ]},
  { group: 'Operations', links: [
    { href: '/requests', label: 'Fuel Requests', roles: ['admin', 'manager', 'attendant'], icon: 'file' },
    { href: '/issue', label: 'Issue Fuel', roles: ['admin', 'manager', 'attendant'], icon: 'drop' },
    { href: '/inventory', label: 'Inventory', roles: ['admin', 'manager', 'attendant'], icon: 'box' },
  ]},
  { group: 'Administration', links: [
    { href: '/vehicles', label: 'Vehicles', roles: ['admin', 'manager', 'attendant'], icon: 'truck' },
    { href: '/configuration', label: 'Configuration', roles: ['admin', 'manager'], icon: 'sliders' },
    { href: '/users', label: 'Users', roles: ['admin'], icon: 'users' },
    { href: '/system', label: 'System', roles: ['admin', 'manager', 'attendant'], icon: 'chip' },
  ]},
];

function Icon({ name, size = 17 }) {
  const p = {
    dash: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M9 13h6M9 17h6" /></>,
    drop: <><path d="M12 2.7s6.5 7 6.5 11.3a6.5 6.5 0 1 1-13 0C5.5 9.7 12 2.7 12 2.7z" /></>,
    box: <><path d="M21 8 12 3 3 8v8l9 5 9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></>,
    truck: <><path d="M1 5h13v11H1zM14 9h4l3 3v4h-7z" /><circle cx="6" cy="18.5" r="1.8" /><circle cx="17" cy="18.5" r="1.8" /></>,
    sliders: <><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></>,
    users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></>,
    chip: <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></>,
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      {p}
    </svg>
  );
}

export default function Shell({ children }) {
  const { user, ready, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);
  const [alerts, setAlerts] = useState(0);

  useEffect(() => {
    setCollapsed(localStorage.getItem('ff_sidebar') === '1');
  }, []);
  // Close transient UI on navigation.
  useEffect(() => { setDrawer(false); setMenu(false); }, [pathname]);
  // Safety net: if somehow unauthenticated, go sign in.
  useEffect(() => { if (ready && !user) router.replace('/login'); }, [ready, user, router]);

  const isDecider = user?.role === 'admin' || user?.role === 'manager';
  useEffect(() => {
    if (!isDecider) return;
    let alive = true;
    const poll = () => api('/api/requests?status=pending&limit=50')
      .then((r) => { if (alive) setAlerts((r.requests || []).length); })
      .catch(() => {});
    poll();
    const iv = setInterval(poll, 60000);
    return () => { alive = false; clearInterval(iv); };
  }, [isDecider, pathname]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem('ff_sidebar', c ? '0' : '1');
      return !c;
    });
  }

  if (!ready) {
    return (
      <div className="login-wrap">
        <p className="muted">Loading…</p>
      </div>
    );
  }
  if (!user) return null;

  const nav = (
    <nav className="nav" aria-label="Main">
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="nav-group">{g.group}</div>
          {g.links.filter((l) => l.roles.includes(user.role)).map((l) => (
            <Link key={l.href} href={l.href} className={pathname === l.href ? 'active' : ''} title={l.label}>
              <Icon name={l.icon} />
              <span className="nav-label">{l.label}</span>
            </Link>
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      {/* Mobile top bar */}
      <header className="topbar">
        <button className="iconbtn" aria-label="Open menu" onClick={() => setDrawer(true)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
        </button>
        <span className="topbar-brand">Fleet Fuel</span>
        <GlobalSearch user={user} compact />
        <AlertBell count={isDecider ? alerts : 0} />
        <UserChip user={user} menu={menu} setMenu={setMenu} logout={logout} compact />
      </header>

      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">⛽</span>
          <span className="brand-text">Fleet Fuel<small>Fuel Management System</small></span>
        </div>
        {nav}
        <button className="collapse-btn" onClick={toggleCollapsed} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          {collapsed ? '»' : '« Collapse'}
        </button>
      </aside>

      {drawer && (
        <div className="overlay drawer-overlay" onClick={() => setDrawer(false)}>
          <div className="drawer-nav" onClick={(e) => e.stopPropagation()}>
            <div className="brand" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="brand-text">Fleet Fuel</span>
              <button className="btn secondary sm" onClick={() => setDrawer(false)} aria-label="Close menu">✕</button>
            </div>
            {nav}
          </div>
        </div>
      )}

      <main className="main">
        <div className="page-head desktop-only">
          <h1>{currentTitle(NAV, pathname)}</h1>
          <div className="head-actions">
            <GlobalSearch user={user} />
            <AlertBell count={isDecider ? alerts : 0} />
            <UserChip user={user} menu={menu} setMenu={setMenu} logout={logout} />
          </div>
        </div>
        {children}
      </main>
    </div>
  );
}

function currentTitle(nav, path) {
  for (const g of nav) for (const l of g.links) if (l.href === path) return l.label;
  return 'Fleet Fuel';
}

function AlertBell({ count }) {
  if (!count) return null;
  return (
    <Link href="/requests" className="bell" title={`${count} request(s) awaiting authorization`} aria-label={`${count} pending approvals`}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
      {count > 0 && <span className="bell-badge">{count > 9 ? '9+' : count}</span>}
    </Link>
  );
}

function UserChip({ user, menu, setMenu, logout, compact }) {
  const initials = String(user?.name || user?.email || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="userchip-wrap">
      <button className="userchip" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu} aria-label="Account menu">
        <span className="avatar" aria-hidden="true">{initials}</span>
        {!compact && (
          <span className="userchip-text">
            <b>{user?.name}</b>
            <small className="muted" style={{ textTransform: 'capitalize' }}>{user?.role}</small>
          </span>
        )}
      </button>
      {menu && (
        <div className="usermenu" role="menu">
          <div className="usermenu-head">
            <b>{user?.name}</b>
            <div className="muted" style={{ fontSize: 12 }}>{user?.email}</div>
            <span className="pill" style={{ marginTop: 6, textTransform: 'capitalize', borderColor: 'var(--accent)', color: 'var(--accent-2)' }}>{user?.role}</span>
          </div>
          <button role="menuitem" onClick={logout}>Sign out</button>
        </div>
      )}
    </div>
  );
}

// Global search: vehicles (server-side ?q=), requests + transactions
// (filtered from the latest server pages — all real API data).
function GlobalSearch({ user, compact }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState(null);
  const box = useRef(null);

  useEffect(() => {
    function onClick(e) { if (box.current && !box.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  useEffect(() => {
    const term = q.trim().toLowerCase();
    if (term.length < 2) { setRes(null); return; }
    const t = setTimeout(async () => {
      try {
        const [v, r, tx] = await Promise.all([
          api(`/api/vehicles?q=${encodeURIComponent(q.trim())}`),
          api('/api/requests?limit=500'),
          api('/api/transactions?limit=300'),
        ]);
        const m = (s) => String(s ?? '').toLowerCase().includes(term);
        setRes({
          vehicles: (v.vehicles || []).filter((x) => m(x.plate) || m(x.make) || m(x.model) || m(x.driver_name)).slice(0, 4),
          requests: (r.requests || []).filter((x) => m(x.request_no) || m(x.plate) || m(x.driver_name) || m(x.status) || m(x.fuel_type_name)).slice(0, 4),
          txns: (tx.transactions || []).filter((x) => m(x.txn_no) || m(x.plate) || m(x.request_no)).slice(0, 4),
        });
        setOpen(true);
      } catch { setRes(null); }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  function go(href) { setQ(''); setRes(null); setOpen(false); window.location.assign(href); }

  const any = res && (res.vehicles.length || res.requests.length || res.txns.length);
  return (
    <div className={`globalsearch ${compact ? 'compact' : ''}`} ref={box}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => res && setOpen(true)}
        placeholder="Search vehicles, requests, transactions…"
        aria-label="Global search"
      />
      {open && q.trim().length >= 2 && (
        <div className="gs-drop">
          {!any && <div className="gs-group"><div className="gs-item muted">No matches for “{q.trim()}”</div></div>}
          {any && res.vehicles.length > 0 && (
            <div className="gs-group">
              <div className="gs-label">Vehicles</div>
              {res.vehicles.map((v) => (
                <button key={v.id} className="gs-item" onClick={() => go(`/vehicles?q=${encodeURIComponent(v.plate)}`)}>
                  <span className="gs-type">Vehicle</span><b>{v.plate}</b><span className="muted">{[v.make, v.model].filter(Boolean).join(' ')}</span>
                </button>
              ))}
            </div>
          )}
          {any && res.requests.length > 0 && (
            <div className="gs-group">
              <div className="gs-label">Fuel requests</div>
              {res.requests.map((r) => (
                <button key={r.id} className="gs-item" onClick={() => go(`/requests?focus=${r.id}`)}>
                  <span className="gs-type">Request</span><b>{r.request_no || '—'}</b><span className="muted">{r.plate} · {r.status}</span>
                </button>
              ))}
            </div>
          )}
          {any && res.txns.length > 0 && (
            <div className="gs-group">
              <div className="gs-label">Fuel transactions</div>
              {res.txns.map((t) => (
                <button key={t.id} className="gs-item" onClick={() => go('/issue')}>
                  <span className="gs-type">Transaction</span><b>{t.txn_no}</b><span className="muted">{t.plate} · {Number(t.quantity).toLocaleString()} L</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
