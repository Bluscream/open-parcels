import type { DatesSetArg, EventClickArg, EventInput } from "@fullcalendar/core";
import allLocales from "@fullcalendar/core/locales-all";
import dayGridPlugin from "@fullcalendar/daygrid";
import listPlugin from "@fullcalendar/list";
import multiMonthPlugin from "@fullcalendar/multimonth";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useCalendar, useCarriers } from "../api/queries";
import { ErrorNotice } from "../components/ui";
import { pickOne, useUrlParam } from "../lib/urlState";
import { UI_HOUR12, UI_LOCALE } from "../lib/locale";
import { toCalendarEvent } from "./events";

/** FullCalendar matches "en-DE" to its "en" locale (12-hour); the hour cycle comes from Intl. */
const TIME_FORMAT = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: UI_HOUR12,
  meridiem: UI_HOUR12 ? "short" : false,
} as const;

function initialRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 20);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 10);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Short names for the address (`?view=week`) and FullCalendar's view ids. */
const VIEWS = {
  month: "dayGridMonth",
  week: "timeGridWeek",
  day: "timeGridDay",
  list: "listWeek",
  year: "multiMonthYear",
} as const;
type ViewName = keyof typeof VIEWS;
const VIEW_NAMES = Object.keys(VIEWS) as ViewName[];

function viewName(fullCalendarId: string): ViewName {
  return VIEW_NAMES.find((name) => VIEWS[name] === fullCalendarId) ?? "month";
}

/** A local calendar day as YYYY-MM-DD. */
function dayString(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Linkable: `?view=month|week|day|list|year` and `?date=YYYY-MM-DD` (a day in the shown range). */
export default function CalendarPage(): ReactNode {
  const [viewParam, setViewParam] = useUrlParam("view");
  const [dateParam, setDateParam] = useUrlParam("date");
  // Read once: FullCalendar takes them only when it mounts; afterwards it reports back.
  const [initial] = useState(() => ({
    view: VIEWS[pickOne(viewParam, VIEW_NAMES, "month")],
    date: dateParam !== null && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : undefined,
  }));
  const [range, setRange] = useState(initialRange);
  const calendar = useCalendar(range.from, range.to);
  const carriers = useCarriers();
  const navigate = useNavigate();

  const events = useMemo<EventInput[]>(
    () =>
      (calendar.data ?? []).map((entry) =>
        toCalendarEvent(
          entry,
          carriers.data?.find((c) => c.id === entry.carrier)?.name ?? entry.carrier,
        ),
      ),
    [calendar.data, carriers.data],
  );

  const onDates = (arg: DatesSetArg): void => {
    const next = { from: arg.start.toISOString(), to: arg.end.toISOString() };
    if (next.from !== range.from || next.to !== range.to) {
      setRange(next);
    }
    const name = viewName(arg.view.type);
    const shownDay = dayString(arg.view.currentStart);
    const today = new Date();
    const containsToday = today >= arg.view.currentStart && today < arg.view.currentEnd;
    const wantedView = name === "month" ? null : name;
    const wantedDate = containsToday ? null : shownDay;
    if (wantedView !== viewParam) setViewParam(wantedView);
    if (wantedDate !== dateParam) setDateParam(wantedDate);
  };

  const onClick = (arg: EventClickArg): void => {
    const parcelId: unknown = arg.event.extendedProps["parcelId"];
    if (typeof parcelId === "string") {
      void navigate({ to: "/parcels/$parcelId", params: { parcelId } });
    }
  };

  return (
    <section aria-labelledby="calendar-title">
      <div className="page-header">
        <h1 id="calendar-title">Calendar</h1>
      </div>
      <ErrorNotice error={calendar.error} />
      <div className="card calendar">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, listPlugin, multiMonthPlugin]}
          initialView={initial.view}
          {...(initial.date === undefined ? {} : { initialDate: initial.date })}
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek,multiMonthYear",
          }}
          locales={allLocales}
          locale={UI_LOCALE}
          eventTimeFormat={TIME_FORMAT}
          slotLabelFormat={TIME_FORMAT}
          firstDay={1}
          height="auto"
          events={events}
          datesSet={onDates}
          eventClick={onClick}
        />
      </div>
    </section>
  );
}
