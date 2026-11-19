import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { setCsrfToken } from "../api/fetcher";
import {
  deleteApiV1AdminPassword,
  deleteApiV1Session,
  putApiV1AdminPassword,
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

/**
 * May change anything: signed in with the admin password, an admin token, or Home Assistant.
 * Everyone else only reads, and the UI hides or disables its editing controls.
 */
export function useIsAdmin(): boolean {
  return useSession().data?.role === "admin";
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

/** Changing the admin password signs every session out, this one included. */
export function useChangeAdminPassword() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { current: string | null; next: string }) => putApiV1AdminPassword(input),
    onSuccess: async () => {
      setCsrfToken(null);
      await client.invalidateQueries({ queryKey: SESSION_KEY });
    },
  });
}

/** Back to OPENPARCELS_ADMIN_PASSWORD; signs every session out. */
export function useResetAdminPassword() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => deleteApiV1AdminPassword(),
    onSuccess: async () => {
      setCsrfToken(null);
      await client.invalidateQueries({ queryKey: SESSION_KEY });
    },
  });
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
