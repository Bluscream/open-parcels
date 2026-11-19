declare module "leaflet-ant-path" {
  import type { Layer, Polyline, PolylineOptions } from "leaflet";

  export interface AntPathOptions extends Omit<PolylineOptions, "dashArray"> {
    readonly use?: (latlngs: [number, number][], options?: PolylineOptions) => Polyline;
    readonly delay?: number;
    readonly dashArray?: number[];
    readonly pulseColor?: string;
    readonly paused?: boolean;
    readonly reverse?: boolean;
    readonly hardwareAccelerated?: boolean;
  }

  export function antPath(latlngs: [number, number][], options?: AntPathOptions): Layer;
}
