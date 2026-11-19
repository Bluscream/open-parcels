import { RouterProvider } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { SetupPage, SignInPage } from "./auth/AuthPages";
import { useSession } from "./auth/session";
import { ErrorNotice, Spinner } from "./components/ui";
import { createAppRouter, type AppRouter } from "./router";

/** Shows setup or sign-in until the session is authenticated, then the app. */
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
  if (session.data.authenticated) {
    return <RouterProvider router={router} />;
  }
  return session.data.setup_required ? <SetupPage /> : <SignInPage />;
}
