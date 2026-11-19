import { Layers } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { MapLayer, MapStyle } from "./layers";

/** A compact button on the map that opens a menu of base styles and the overlay toggle. */
export function LayerControl(props: {
  readonly layers: readonly MapLayer[];
  readonly base: MapLayer;
  readonly overlay: MapLayer | null;
  readonly onChoose: (change: Partial<MapStyle>) => void;
}): ReactNode {
  const { layers, base, overlay, onChoose } = props;
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const bases = layers.filter((layer) => layer.kind === "base");
  const overlays = layers.filter((layer) => layer.kind === "overlay");

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent | KeyboardEvent): void => {
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !root.current?.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (bases.length + overlays.length <= 1) return null;
  return (
    // Leaflet must not turn clicks and scrolls in the menu into map pans and zooms.
    <div
      ref={root}
      className="map-layer-control"
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
      }}
      onWheel={(event) => {
        event.stopPropagation();
      }}
    >
      <button
        type="button"
        className="map-layer-button"
        aria-label="Map style"
        title="Map style"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <Layers size={18} aria-hidden="true" />
      </button>
      {open ? (
        <fieldset id={menuId} className="map-layer-menu">
          <legend>Map style</legend>
          {bases.map((layer) => (
            <label key={layer.id}>
              <input
                type="radio"
                name={`${menuId}-base`}
                checked={layer.id === base.id}
                onChange={() => {
                  onChoose({ base: layer.id });
                }}
              />
              {layer.label}
            </label>
          ))}
          {overlays.map((layer) => (
            <label key={layer.id} className="map-layer-overlay">
              <input
                type="checkbox"
                checked={overlay?.id === layer.id}
                onChange={(event) => {
                  onChoose({ overlay: event.target.checked ? layer.id : null });
                }}
              />
              {layer.label}
            </label>
          ))}
        </fieldset>
      ) : null}
    </div>
  );
}
