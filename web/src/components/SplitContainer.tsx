import { useSyncExternalStore, type ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

const NARROW = "(max-width: 900px)";

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function isNarrow(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches;
}

/**
 * Two panels side by side with a draggable divider, as in the original UI. On narrow screens the
 * panels stack instead, first panel on top.
 */
export function SplitContainer(props: {
  readonly leftPanel: ReactNode;
  readonly rightPanel: ReactNode;
  readonly leftDefaultSize?: number;
  readonly rightDefaultSize?: number;
  readonly leftMinSize?: number;
  readonly rightMinSize?: number;
}): ReactNode {
  const narrow = useSyncExternalStore(subscribe, isNarrow, () => false);
  if (narrow) {
    return (
      <div className="stacked">
        {props.leftPanel}
        {props.rightPanel}
      </div>
    );
  }
  return (
    <Group orientation="horizontal" style={{ height: "100%", width: "100%" }}>
      <Panel defaultSize={props.leftDefaultSize ?? 40} minSize={props.leftMinSize ?? 20}>
        {props.leftPanel}
      </Panel>
      <Separator className="split-handle" aria-label="Resize panels" />
      <Panel defaultSize={props.rightDefaultSize ?? 60} minSize={props.rightMinSize ?? 30}>
        {props.rightPanel}
      </Panel>
    </Group>
  );
}
