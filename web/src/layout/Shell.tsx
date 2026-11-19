import { Link, Outlet } from "@tanstack/react-router";
import { Suspense, type ReactNode } from "react";
import { useLiveUpdates, type LiveState } from "../api/events";
import { useSession, useSignOut } from "../auth/session";
import { Spinner } from "../components/ui";
import { useTheme, type ThemeChoice } from "../lib/theme";

const NAV = [
  { to: "/", label: "Parcels" },
  { to: "/map", label: "Map" },
  { to: "/calendar", label: "Calendar" },
  { to: "/sources", label: "Sources" },
  { to: "/tokens", label: "API tokens" },
  { to: "/status", label: "Status" },
] as const;

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
  const isIngress = session.data?.method === "ingress";

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <span className="brand">📦 open-parcels</span>
        <nav aria-label="Main">
          <ul className="nav">
            {NAV.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: item.to === "/" }}
                  activeProps={{ "aria-current": "page", className: "active" }}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="topbar-tools">
          <span className={`live live-${live}`} role="status" title="Live updates">
            {LIVE_LABELS[live]}
          </span>
          <ThemePicker />
          {isIngress || session.data?.method !== "session" ? null : (
            <button
              type="button"
              className="button"
              onClick={() => {
                signOut.mutate();
              }}
            >
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
    </div>
  );
}
