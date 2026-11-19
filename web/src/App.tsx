import { RouterProvider } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { SetupPage, SignInPage } from "./auth/AuthPages";
import { useSession } from "./auth/session";
import { ErrorNotice, Spinner } from "./components/ui";
import { createAppRouter, type AppRouter } from "./router";

/**
 * Shows setup or sign-in until the caller may read, then the app. Without a reader password
 * everyone may read, so the app opens at once (read only until the admin signs in).
 */
export function App(props: { readonly router?: AppRouter }): ReactNode {
  const session = useSession();
  const [router] = useState(() => props.router ?? createAppRouter());

  if (session.isPending) {
    return <Spinner label="Starting…" />;
  }
  if (session.isError) {
    return (
      <main className="auth-page">
        <ErrorNotice error={session.error} />
      </main>
    );
  }
  if (session.data.role !== null) {
    return <RouterProvider router={router} />;
  }
  return session.data.setup_required ? <SetupPage /> : <SignInPage />;
}
