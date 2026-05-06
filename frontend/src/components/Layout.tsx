import { NavLink, Outlet } from 'react-router-dom';
import { Activity, BarChart3, Bell, Crosshair, Gauge, Radar, Settings } from 'lucide-react';
import { useUiStore } from '../store/uiStore';

const links = [
  { to: '/', label: 'Dashboard', icon: Gauge },
  { to: '/setups', label: 'Actionable Setups', icon: Crosshair },
  { to: '/tactical', label: 'Tactical Watch', icon: Radar },
  { to: '/analytics', label: 'Snapshot Analytics', icon: BarChart3 },
  { to: '/alerts', label: 'Alerts', icon: Bell }
];

export function Layout() {
  const refreshInterval = useUiStore(state => state.refreshInterval);
  const setRefreshInterval = useUiStore(state => state.setRefreshInterval);
  const locale = useUiStore(state => state.locale);
  const setLocale = useUiStore(state => state.setLocale);

  return (
    <div className="min-h-screen bg-[#09111f] text-slate-100">
      <div className="fixed inset-0 -z-10 bg-[radial-gradient(circle_at_20%_10%,rgba(245,158,11,0.18),transparent_28%),radial-gradient(circle_at_80%_0%,rgba(14,165,233,0.16),transparent_30%),linear-gradient(135deg,#09111f_0%,#111827_45%,#0b1220_100%)]" />
      <div className="flex min-h-screen">
        <aside className="hidden w-72 border-r border-white/10 bg-black/20 p-5 backdrop-blur-xl lg:block">
          <div className="mb-10 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-400 text-slate-950">
              <Activity size={22} />
            </div>
            <div>
              <div className="font-display text-lg font-bold">MTF 4H Console</div>
              <div className="text-xs text-slate-400">Decision support, not execution</div>
            </div>
          </div>
          <nav className="space-y-2">
            {links.map(link => {
              const Icon = link.icon;
              return (
                <NavLink
                  key={link.to}
                  to={link.to}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                      isActive ? 'bg-white/12 text-white' : 'text-slate-400 hover:bg-white/8 hover:text-white'
                    }`
                  }
                >
                  <Icon size={18} />
                  {link.label}
                </NavLink>
              );
            })}
          </nav>
        </aside>
        <main className="flex-1">
          <header className="sticky top-0 z-20 border-b border-white/10 bg-[#09111f]/80 px-5 py-4 backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="font-display text-2xl font-bold">Crypto MTF Analysis — 4H Setup</div>
                <div className="text-sm text-slate-400">Main 4H setup and Tactical 1H entry are separate layers.</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300">
                  Language
                  <select
                    className="bg-transparent text-white outline-none"
                    value={locale}
                    onChange={event => setLocale(event.target.value as 'ru' | 'en')}
                  >
                    <option value="ru">RU</option>
                    <option value="en">EN</option>
                  </select>
                </label>
                <label className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300">
                  <Settings size={16} />
                  Refresh
                  <select
                    className="bg-transparent text-white outline-none"
                    value={refreshInterval}
                    onChange={event => setRefreshInterval(Number(event.target.value))}
                  >
                    <option value={15000}>15s</option>
                    <option value={30000}>30s</option>
                    <option value={60000}>1m</option>
                    <option value={300000}>5m</option>
                  </select>
                </label>
              </div>
            </div>
          </header>
          <div className="p-5">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
