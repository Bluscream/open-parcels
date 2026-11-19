import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteApiV1SettingsConfigKey,
  getApiV1SettingsConfig,
  patchApiV1SettingsConfig,
  type GetApiV1SettingsConfig200Item,
} from "../api/generated";
import { mapLayersKey } from "../map/layers";

export { useIsAdmin } from "../auth/session";

export type ServerSetting = GetApiV1SettingsConfig200Item;
export type ServerSettingValue = string | number | boolean;

export const serverSettingsKey = ["settings", "config"] as const;

/** The passwords' group: edited on the Security card, not the generic editor. */
export const SECURITY_GROUP = "Security";

export function useServerSettings() {
  return useQuery({
    queryKey: serverSettingsKey,
    queryFn: ({ signal }) => getApiV1SettingsConfig({ signal }),
  });
}

export function useSaveServerSetting() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (change: { readonly key: string; readonly value: ServerSettingValue }) =>
      patchApiV1SettingsConfig({ [change.key]: change.value }),
    onSuccess: (list) => {
      client.setQueryData(serverSettingsKey, list);
      // Map defaults and the custom provider change the layer list.
      void client.invalidateQueries({ queryKey: mapLayersKey });
    },
  });
}

export function useResetServerSetting() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => deleteApiV1SettingsConfigKey(key),
    onSuccess: (list) => {
      client.setQueryData(serverSettingsKey, list);
      // Map defaults and the custom provider change the layer list.
      void client.invalidateQueries({ queryKey: mapLayersKey });
    },
  });
}

/** Settings by group, in the order the server lists them. */
export function groupSettings(settings: readonly ServerSetting[]): [string, ServerSetting[]][] {
  const groups = new Map<string, ServerSetting[]>();
  for (const setting of settings) {
    const group = groups.get(setting.group) ?? [];
    group.push(setting);
    groups.set(setting.group, group);
  }
  return [...groups];
}

/** The key without its OPENPARCELS_ prefix, for display. */
export const shortKey = (key: string): string => key.replace(/^OPENPARCELS_/, "");

export function formatValue(value: ServerSettingValue | null): string {
  if (value === null) return "unset";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

/** Turns the editor's text back into the setting's type; null when it is not one. */
export function fromText(setting: ServerSetting, text: string): ServerSettingValue | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (setting.kind === "boolean") return trimmed === "true";
  if (setting.kind === "number") {
    const number = Number(trimmed);
    return Number.isFinite(number) ? number : null;
  }
  return trimmed;
}

export const SOURCE_LABELS = {
  env: "environment",
  default: "default",
  override: "saved in UI",
} as const;

export const APPLY_LABELS = {
  live: "live",
  restart: "restart",
  env: "environment only",
} as const;
