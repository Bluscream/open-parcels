import type L from "leaflet";
import { Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode, type SyntheticEvent } from "react";
import { Marker, useMapEvents } from "react-leaflet";
import { ErrorNotice, Spinner, errorMessage } from "../components/ui";
import { formatLatLng, parseLatLng, type LatLngTuple } from "../lib/geo";
import { iconHome } from "../map/mapIcons";
import { SharedMap } from "../map/SharedMap";
import {
  searchPlaces,
  useClearHome,
  useHome,
  useParcelLabel,
  useSaveHome,
  useSaveParcelLabel,
  type Home,
  type ParcelLabelMode,
} from "./home";

interface Place {
  readonly label: string;
  readonly latitude: number;
  readonly longitude: number;
}

/** Clicking the map moves the home there. */
function ClickToPlace({ onPlace }: { readonly onPlace: (point: LatLngTuple) => void }): null {
  useMapEvents({
    click: (event) => {
      onPlace([event.latlng.lat, event.latlng.lng]);
    },
  });
  return null;
}

function HomeSection(): ReactNode {
  const { home, loading } = useHome();
  const save = useSaveHome();
  const clear = useClearHome();
  const [text, setText] = useState<string | null>(null);
  const [places, setPlaces] = useState<readonly Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const shown = text ?? (home === null ? "" : (home.label ?? formatLatLng(home.point)));
  const point = home?.point ?? null;
  const bounds = useMemo(() => (point === null ? undefined : [point]), [point]);

  const place = (next: Home): void => {
    setPlaces(null);
    setText(null);
    save.mutate(next);
  };

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const value = shown.trim();
    if (value.length === 0) return;
    const coordinates = parseLatLng(value);
    if (coordinates !== null) {
      place({ point: coordinates, label: null });
      return;
    }
    setSearching(true);
    setSearchError(null);
    searchPlaces(value)
      .then((found) => {
        if (found.length === 1 && found[0] !== undefined) {
          place({ point: [found[0].latitude, found[0].longitude], label: found[0].label });
        } else {
          setPlaces(found);
        }
      })
      .catch((error: unknown) => {
        setSearchError(errorMessage(error));
      })
      .finally(() => {
        setSearching(false);
      });
  };

  if (loading) return <Spinner />;
  return (
    <section className="card stack" aria-labelledby="home-title">
      <h2 id="home-title">Home location</h2>
      <p className="muted">
        Where your parcels go. The maps centre on it, draw the way still ahead and show how far a
        parcel is. Type an address or coordinates (“52.520008, 13.404954”), or click the map.
      </p>
      <form className="search-row" onSubmit={submit}>
        <div className="input-with-clear">
          <input
            aria-label="Address or coordinates"
            value={shown}
            placeholder="Address, place or “latitude, longitude”"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setPlaces(null);
            }}
          />
          {shown.length > 0 ? (
            <button
              type="button"
              className="clear-button"
              aria-label="Clear the box"
              onClick={() => {
                setText("");
                setPlaces(null);
                setSearchError(null);
              }}
            >
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <button type="submit" className="button primary" disabled={searching || save.isPending}>
          <Search size={16} aria-hidden="true" /> {searching ? "Searching…" : "Find"}
        </button>
      </form>
      {searchError === null ? null : <p className="error">{searchError}</p>}
      {places === null ? null : places.length === 0 ? (
        <p className="muted">Nothing found. Try a fuller address or coordinates.</p>
      ) : (
        <ul className="place-results" aria-label="Places found">
          {places.map((found) => (
            <li key={`${String(found.latitude)},${String(found.longitude)}`}>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  place({ point: [found.latitude, found.longitude], label: found.label });
                }}
              >
                {found.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="settings-map">
        <SharedMap
          label="Home location"
          {...(point === null ? {} : { center: point, zoom: 16 })}
          {...(bounds === undefined ? {} : { bounds, fitMaxZoom: 17 })}
        >
          <ClickToPlace
            onPlace={(clicked) => {
              place({ point: clicked, label: null });
            }}
          />
          {point === null ? null : (
            <Marker
              position={[point[0], point[1]]}
              icon={iconHome}
              draggable
              eventHandlers={{
                dragend: (event) => {
                  const { lat, lng } = (event.target as L.Marker).getLatLng();
                  place({ point: [lat, lng], label: null });
                },
              }}
            />
          )}
        </SharedMap>
      </div>
      <p className="muted" role="status" aria-live="polite">
        {save.isPending
          ? "Saving…"
          : point === null
            ? "No home location set."
            : `Saved: ${formatLatLng(point)}`}
      </p>
      <ErrorNotice error={save.error ?? clear.error} />
      {home === null ? null : (
        <div className="actions">
          <button
            type="button"
            className="button danger"
            disabled={clear.isPending}
            onClick={() => {
              setText(null);
              clear.mutate();
            }}
          >
            Remove home location
          </button>
        </div>
      )}
    </section>
  );
}

function LabelSection(): ReactNode {
  const mode = useParcelLabel();
  const save = useSaveParcelLabel();
  return (
    <section className="card stack" aria-labelledby="label-title">
      <h2 id="label-title">Default parcel label</h2>
      <p className="muted">
        How a parcel is named when you have not given it a label yourself, here and in Home
        Assistant.
      </p>
      <label className="field">
        <span>Name parcels by</span>
        <select
          value={save.isPending ? save.variables : mode}
          disabled={save.isPending}
          onChange={(e) => {
            save.mutate(e.target.value as ParcelLabelMode);
          }}
        >
          <option value="tracking_number">Tracking number (default)</option>
          <option value="items">Item names (max 100 characters)</option>
        </select>
      </label>
      <ErrorNotice error={save.error} />
    </section>
  );
}

export function SettingsPage(): ReactNode {
  return (
    <section aria-labelledby="settings-title" className="stack">
      <div className="page-header">
        <h1 id="settings-title">Settings</h1>
      </div>
      <HomeSection />
      <LabelSection />
    </section>
  );
}
