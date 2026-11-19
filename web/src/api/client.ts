import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { SESSION_KEY } from "../auth/session";
import { ApiError } from "./fetcher";

/**
 * The app's query client. A 401 anywhere, from a read or from a change, means the session ended:
 * the session is asked again, which shows the sign-in page.
 */
export function createQueryClient(): QueryClient {
  const signedOut = (error: unknown): boolean => error instanceof ApiError && error.status === 401;
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        const scope: unknown = query.queryKey[0];
        if (signedOut(error) && scope !== SESSION_KEY[0]) {
          void client.invalidateQueries({ queryKey: SESSION_KEY });
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        if (signedOut(error)) {
          void client.invalidateQueries({ queryKey: SESSION_KEY });
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
  return client;
}
