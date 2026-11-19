import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "./api/fetcher";
import { SESSION_KEY } from "./auth/session";
import { App } from "./App";
import "./styles.css";

const queryClient: QueryClient = new QueryClient({
  // A 401 anywhere means the session ended: ask again, which shows the sign-in page.
  queryCache: new QueryCache({
    onError: (error, query) => {
      const scope: unknown = query.queryKey[0];
      if (error instanceof ApiError && error.status === 401 && scope !== SESSION_KEY[0]) {
        void queryClient.invalidateQueries({ queryKey: SESSION_KEY });
      }
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
    },
  },
});

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}
