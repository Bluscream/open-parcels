import { Link, Outlet } from "@tanstack/react-router";
import {
  Activity,
  CalendarDays,
  KeyRound,
  LogOut,
  Map,
  Package,
  Plug,
  Plus,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";
import { Suspense, useState, type ReactNode } from "react";
import { useLiveUpdates, type LiveState } from "../api/events";
import { useSession, useSignOut } from "../auth/session";
import { Spinner } from "../components/ui";
import { useTheme, type ThemeChoice } from "../lib/theme";
import { AddParcelDialog } from "../parcels/AddParcelDialog";

const NAV = [
  { to: "/", label: "Parcels", icon: Package },
  { to: "/map", label: "Live Map", icon: Map },
  { to: "/orders", label: "Orders", icon: ShoppingBag },
  { to: "/calendar", label: "Calendar", icon: CalendarDays },
  { to: "/sources", label: "Sources", icon: Plug },
  { to: "/tokens", label: "API tokens", icon: KeyRound },
  { to: "/status", label: "Status", icon: Activity },
] as const satisfies readonly { to: string; label: string; icon: LucideIcon }[];

const LIVE_LABELS: Readonly<Record<LiveState, string>> = {
  connecting: "Connecting…",
  live: "Live",
  offline: "Offline",
};

function ThemePicker(): ReactNode {
  const [theme, setTheme] = useTheme();
  return (
    <label className="theme-picker">
      <span className="visually-hidden">Theme</span>
      <select
        value={theme}
        onChange={(e) => {
          setTheme(e.target.value as ThemeChoice);
        }}
      >
        <option value="system">System theme</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
  );
}

export function Shell(): ReactNode {
  const session = useSession();
  const signOut = useSignOut();
  const live = useLiveUpdates(true);
  const [adding, setAdding] = useState(false);
  const isIngress = session.data?.method === "ingress";

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand">
          <img className="brand-logo" src="favicon.svg" alt="" />
          Open Parcels
        </Link>
        <nav aria-label="Main">
          <ul className="nav">
            {NAV.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  title={item.label}
                  activeOptions={{ exact: item.to === "/" }}
                  activeProps={{ "aria-current": "page", className: "active" }}
                >
                  <item.icon size={15} aria-hidden="true" />
                  <span>{item.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="topbar-tools">
          <button
            type="button"
            className="header-link"
            onClick={() => {
              setAdding(true);
            }}
          >
            <Plus size={16} aria-hidden="true" />
            Add
          </button>
          <span className={`live live-${live}`} role="status" title="Live updates">
            {LIVE_LABELS[live]}
          </span>
          <ThemePicker />
          {isIngress || session.data?.method !== "session" ? null : (
            <button
              type="button"
              className="header-link"
              onClick={() => {
                signOut.mutate();
              }}
            >
              <LogOut size={16} aria-hidden="true" />
              Sign out
            </button>
          )}
        </div>
      </header>
      <main id="main" className="content">
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </main>
      <AddParcelDialog
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
      />
    </div>
  );
}
