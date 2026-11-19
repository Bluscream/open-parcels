/**
 * TanStack Query hooks over the generated API functions. Query keys live here so live events and
 * mutations invalidate the same entries.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1ParcelsId,
  deleteApiV1SourcesId,
  deleteApiV1TokensId,
  getApiV1Calendar,
  getApiV1Carriers,
  getApiV1Diagnostics,
  getApiV1HealthReady,
  getApiV1Parcels,
  getApiV1ParcelsId,
  getApiV1Sources,
  getApiV1Tokens,
  patchApiV1ParcelsId,
  patchApiV1SourcesId,
  postApiV1Parcels,
  postApiV1Sources,
  postApiV1SourcesIdSync,
  postApiV1Tokens,
  type PatchApiV1ParcelsIdBody,
  type PatchApiV1SourcesIdBody,
  type PostApiV1ParcelsBody,
  type PostApiV1SourcesBody,
  type PostApiV1TokensBody,
} from "./generated";

export const keys = {
  parcels: ["parcels"] as const,
  parcelList: (archived: boolean) => ["parcels", "list", { archived }] as const,
  parcel: (id: string) => ["parcels", "one", id] as const,
  sources: ["sources"] as const,
  carriers: ["carriers"] as const,
  tokens: ["tokens"] as const,
  calendar: (from: string, to: string) => ["calendar", from, to] as const,
  health: ["health"] as const,
  diagnostics: ["diagnostics"] as const,
};

export function useParcels(includeArchived: boolean) {
  return useQuery({
    queryKey: keys.parcelList(includeArchived),
    queryFn: ({ signal }) =>
      getApiV1Parcels(
        { limit: 1000, ...(includeArchived ? { include_archived: "true" } : {}) },
        { signal },
      ),
  });
}

export function useParcel(id: string) {
  return useQuery({
    queryKey: keys.parcel(id),
    queryFn: ({ signal }) => getApiV1ParcelsId(id, { signal }),
  });
}

export function useCarriers() {
  return useQuery({
    queryKey: keys.carriers,
    queryFn: ({ signal }) => getApiV1Carriers({ signal }),
    staleTime: 5 * 60_000,
  });
}

export function useSources() {
  return useQuery({ queryKey: keys.sources, queryFn: ({ signal }) => getApiV1Sources({ signal }) });
}

export function useTokens() {
  return useQuery({ queryKey: keys.tokens, queryFn: ({ signal }) => getApiV1Tokens({ signal }) });
}

export function useCalendar(from: string, to: string) {
  return useQuery({
    queryKey: keys.calendar(from, to),
    queryFn: ({ signal }) => getApiV1Calendar({ from, to }, { signal }),
  });
}

export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: ({ signal }) => getApiV1HealthReady({ signal }),
    refetchInterval: 30_000,
  });
}

export function useDiagnostics() {
  return useQuery({
    queryKey: keys.diagnostics,
    queryFn: ({ signal }) => getApiV1Diagnostics({ signal }),
  });
}

export function useAddParcel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PostApiV1ParcelsBody) => postApiV1Parcels(body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.parcels }),
  });
}

export function useUpdateParcel(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchApiV1ParcelsIdBody) => patchApiV1ParcelsId(id, body),
    onSuccess: (parcel) => {
      client.setQueryData(keys.parcel(id), parcel);
      return client.invalidateQueries({ queryKey: keys.parcels });
    },
  });
}

export function useDeleteParcel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiV1ParcelsId(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.parcels }),
  });
}

export function useAddSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PostApiV1SourcesBody) => postApiV1Sources(body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sources }),
  });
}

export function useUpdateSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchApiV1SourcesIdBody }) =>
      patchApiV1SourcesId(id, body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sources }),
  });
}

export function useDeleteSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiV1SourcesId(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sources }),
  });
}

export function useSyncSource() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => postApiV1SourcesIdSync(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.sources }),
  });
}

export function useCreateToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: PostApiV1TokensBody) => postApiV1Tokens(body),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.tokens }),
  });
}

export function useRevokeToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteApiV1TokensId(id),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.tokens }),
  });
}
