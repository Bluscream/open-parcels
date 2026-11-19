/**
 * A coloured carrier tile, standing in for the original UI's logo images: the API has no logo URLs
 * yet, so well-known carriers get their brand colour and the rest a stable colour from their id.
 */
import type { CSSProperties, ReactNode } from "react";
import { useCarriers } from "../api/queries";

const BRAND: Readonly<Record<string, readonly [string, string]>> = {
  dhl: ["#ffcc00", "#d40511"],
  dpd: ["#dc0032", "#ffffff"],
  ups: ["#351c15", "#ffb500"],
  gls: ["#061ab1", "#ffd100"],
  hermes: ["#0091cd", "#ffffff"],
  fedex: ["#4d148c", "#ff6600"],
  amazon: ["#232f3e", "#ff9900"],
  postnl: ["#ff6200", "#ffffff"],
  usps: ["#333366", "#ffffff"],
};

function colours(id: string): readonly [string, string] {
  const known = BRAND[id.toLowerCase()];
  if (known !== undefined) {
    return known;
  }
  let hash = 0;
  for (const char of id) {
    hash = (hash * 31 + char.charCodeAt(0)) % 360;
  }
  return [`hsl(${hash} 55% 42%)`, "#ffffff"];
}

function initials(name: string): string {
  const words = name.split(/[\s_-]+/).filter((word) => word !== "");
  const text = words.length > 1 ? words.map((word) => word.charAt(0)).join("") : name;
  return text.slice(0, 3);
}

/** The carrier's display name from the plug-in list, or its id. */
export function useCarrierName(id: string): string {
  const carriers = useCarriers();
  return carriers.data?.find((carrier) => carrier.id === id)?.name ?? id;
}

export function CarrierLogo(props: {
  readonly carrier: string;
  readonly size?: number;
}): ReactNode {
  const size = props.size ?? 40;
  const [background, color] = colours(props.carrier);
  const style: CSSProperties = {
    width: size,
    height: size,
    background,
    color,
    fontSize: Math.round(size * 0.3),
  };
  return (
    // The initials come from CSS (`attr(data-initials)`): the tile is decoration, and the carrier
    // name is always written out next to it.
    <span
      className="carrier-logo"
      style={style}
      aria-hidden="true"
      data-initials={initials(props.carrier)}
    />
  );
}
