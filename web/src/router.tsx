import {
  createRootRoute,
  createRoute,
  createRouter,
  type RouterHistory,
} from "@tanstack/react-router";
import { lazy, type ReactNode } from "react";
import { StatusPage } from "./admin/StatusPage";
import { TokensPage } from "./admin/TokensPage";
import { Shell } from "./layout/Shell";
import { OrdersPage } from "./orders/OrdersPage";
import { ParcelDetailPage } from "./parcels/ParcelDetailPage";
import { ParcelsPage } from "./parcels/ParcelsPage";
import { SourcesPage } from "./sources/SourcesPage";

// Leaflet and FullCalendar are large; load them only when their tab opens.
const MapPage = lazy(() => import("./map/MapPage"));
const CalendarPage = lazy(() => import("./calendar/CalendarPage"));

const rootRoute = createRootRoute({ component: Shell });

const parcelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/parcels/$parcelId",
  component: ParcelRoute,
});

function ParcelRoute(): ReactNode {
  // The route's own param type is circular here (the router type includes this component), so
  // read it as unknown and narrow.
  const params: unknown = parcelRoute.useParams();
  const parcelId =
    typeof params === "object" && params !== null && "parcelId" in params
      ? String(params.parcelId)
      : "";
  return <ParcelDetailPage parcelId={parcelId} />;
}

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: ParcelsPage }),
  parcelRoute,
  createRoute({ getParentRoute: () => rootRoute, path: "/sources", component: SourcesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/map", component: MapPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/orders", component: OrdersPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/calendar", component: CalendarPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/tokens", component: TokensPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/status", component: StatusPage }),
]);

/** `/`, or the Home Assistant ingress prefix the server wrote into `<base href>`. */
export function basePath(): string {
  const path = new URL(document.baseURI).pathname;
  return path.length > 1 ? path.replace(/\/$/, "") : "/";
}

export function createAppRouter(history?: RouterHistory) {
  return createRouter({
    routeTree,
    basepath: basePath(),
    defaultPreload: "intent",
    ...(history === undefined ? {} : { history }),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
