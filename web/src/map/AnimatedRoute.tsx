import L from "leaflet";
import { antPath } from "leaflet-ant-path";
import { useEffect } from "react";
import { useMap } from "react-leaflet";
import type { LatLng } from "./mapIcons";

/**
 * An animated "marching ants" line between points: the maps draw it from the carrier's last scan
 * to the courier's live position. No trail of past courier positions is ever drawn.
 */
export function AnimatedRoute(props: {
  readonly positions: readonly LatLng[];
  readonly color?: string;
  readonly dashArray?: string;
}): null {
  const map = useMap();
  const color = props.color ?? "#a78bfa";
  const dashArray = props.dashArray ?? "10, 20";

  useEffect(() => {
    if (props.positions.length === 0) {
      return undefined;
    }
    const dashes = dashArray.split(",").map(Number);
    const solid = dashes.length >= 2 && dashes[0] === 0 && dashes[1] === 0;
    const path = antPath([...props.positions], {
      use: L.polyline,
      delay: 600,
      dashArray: dashes,
      weight: 4,
      color: solid ? color : "rgba(0,0,0,0)",
      pulseColor: color,
      paused: solid,
      reverse: false,
      hardwareAccelerated: true,
    });
    path.addTo(map);
    return () => {
      map.removeLayer(path);
    };
  }, [props.positions, color, dashArray, map]);

  return null;
}
