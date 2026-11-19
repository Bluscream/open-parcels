import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { setCsrfToken } from "../api/fetcher";
import {
  deleteApiV1Session,
  getApiV1Session,
  postApiV1Session,
  postApiV1Setup,
} from "../api/generated";

export const SESSION_KEY = ["session"] as const;

export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: async ({ signal }) => {
      const session = await getApiV1Session({ signal });
      setCsrfToken(session.csrf_token);
      return session;
    },
    staleTime: Infinity,
    retry: 1,
  });
}

/** After setup or sign-in the server has set the cookie; ask again who we are. */
function useSessionMutation<TInput>(call: (input: TInput) => Promise<{ csrf_token: string }>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: async (result) => {
      setCsrfToken(result.csrf_token);
      await client.invalidateQueries({ queryKey: SESSION_KEY });
    },
  });
}

export function useSetup() {
  return useSessionMutation((input: { setupCode: string; password: string }) =>
    postApiV1Setup({ setup_code: input.setupCode, password: input.password }),
  );
}

export function useSignIn() {
  return useSessionMutation((password: string) => postApiV1Session({ password }));
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => deleteApiV1Session(),
    onSuccess: () => {
      setCsrfToken(null);
      client.clear();
    },
  });
}
