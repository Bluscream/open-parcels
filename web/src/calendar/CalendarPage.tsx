import type { DatesSetArg, EventClickArg, EventInput } from "@fullcalendar/core";
import dayGridPlugin from "@fullcalendar/daygrid";
import listPlugin from "@fullcalendar/list";
import multiMonthPlugin from "@fullcalendar/multimonth";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { useCalendar } from "../api/queries";
import { ErrorNotice } from "../components/ui";

function initialRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 20);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 10);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function CalendarPage(): ReactNode {
  const [range, setRange] = useState(initialRange);
  const calendar = useCalendar(range.from, range.to);
  const navigate = useNavigate();

  const events = useMemo<EventInput[]>(
    () =>
      (calendar.data ?? []).map((entry) => ({
        id: entry.uid,
        title: `${entry.title} (${entry.carrier})`,
        start: entry.start,
        end: entry.end,
        allDay: entry.all_day,
        classNames: [`cal-${entry.kind}`, ...(entry.late ? ["cal-late"] : [])],
        extendedProps: { parcelId: entry.parcel_id },
      })),
    [calendar.data],
  );

  const onDates = (arg: DatesSetArg): void => {
    const next = { from: arg.start.toISOString(), to: arg.end.toISOString() };
    if (next.from !== range.from || next.to !== range.to) {
      setRange(next);
    }
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
          initialView="dayGridMonth"
          headerToolbar={{
            left: "prev,next today",
            center: "title",
            right: "dayGridMonth,timeGridWeek,timeGridDay,listWeek,multiMonthYear",
          }}
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
