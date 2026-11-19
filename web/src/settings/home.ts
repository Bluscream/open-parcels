import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1SettingsHome,
  getApiV1Geocode,
  getApiV1Settings,
  putApiV1SettingsHome,
  putApiV1SettingsParcelLabel,
} from "../api/generated";
import { keys } from "../api/queries";
import type { LatLngTuple } from "../lib/geo";

export const settingsKey = ["settings"] as const;

export interface Home {
  readonly point: LatLngTuple;
  readonly label: string | null;
}

/** The home location set on the Settings page, or null. Read by the maps and distances. */
export function useHome(): { readonly home: Home | null; readonly loading: boolean } {
  const query = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => getApiV1Settings({ signal }),
    staleTime: 5 * 60_000,
  });
  const home = query.data?.home;
  return {
    home:
      home === null || home === undefined
        ? null
        : { point: [home.latitude, home.longitude], label: home.label },
    loading: query.isPending,
  };
}

export function useSaveHome() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (home: Home) =>
      putApiV1SettingsHome({
        latitude: home.point[0],
        longitude: home.point[1],
        label: home.label,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: settingsKey }),
  });
}

export function useClearHome() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => deleteApiV1SettingsHome(),
    onSuccess: () => client.invalidateQueries({ queryKey: settingsKey }),
  });
}

/** Address search through the server (OpenStreetMap Nominatim). */
export function searchPlaces(text: string, signal?: AbortSignal) {
  return getApiV1Geocode({ q: text }, signal === undefined ? {} : { signal });
}

export type ParcelLabelMode = "tracking_number" | "items";

/** How parcels without a label are named; "tracking_number" until the settings arrive. */
export function useParcelLabel(): ParcelLabelMode {
  const query = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => getApiV1Settings({ signal }),
    staleTime: 5 * 60_000,
  });
  return query.data?.parcel_label ?? "tracking_number";
}

export function useSaveParcelLabel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (mode: ParcelLabelMode) => putApiV1SettingsParcelLabel({ parcel_label: mode }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: settingsKey });
      // Every parcel's name may change.
      await client.invalidateQueries({ queryKey: keys.parcels });
    },
  });
}
