import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useState } from "react";

/**
 * Page state kept in the address (`?status=delivered`, `?view=week`), so a filtered view can be
 * linked, bookmarked and reloaded. Values are plain strings; the address is replaced, not pushed,
 * so changing a filter does not fill the back button's history.
 */
export function useUrlParam(key: string): [string | null, (value: string | null) => void] {
  const router = useRouter();
  const search = useRouterState({ select: (state) => state.location.searchStr });
  const value = new URLSearchParams(search).get(key);
  const setValue = useCallback(
    (next: string | null) => {
      const { pathname, search: current, hash } = router.history.location;
      const params = new URLSearchParams(current);
      if (next === null || next === "") {
        params.delete(key);
      } else {
        params.set(key, next);
      }
      const query = params.toString();
      router.history.replace(`${pathname}${query === "" ? "" : `?${query}`}${hash}`);
    },
    [router, key],
  );
  return [value, setValue];
}

/** Like `useUrlParam`, but only in memory when no key is given (pages that do not link state). */
export function useMaybeUrlParam(
  key: string | undefined,
): [string | null, (value: string | null) => void] {
  const fromUrl = useUrlParam(key ?? "");
  const local = useState<string | null>(null);
  return key === undefined ? local : fromUrl;
}

/** The allowed value matching `raw` regardless of case ("Delivered" finds "delivered"), else the fallback. */
export function pickOne<T extends string>(
  raw: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === null) return fallback;
  const wanted = raw.trim().toLowerCase();
  return allowed.find((option) => option.toLowerCase() === wanted) ?? fallback;
}

/** "1", "true", "yes" and "on" are true; anything else, or nothing, is false. */
export function flag(raw: string | null): boolean {
  return raw !== null && ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
