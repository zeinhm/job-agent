import { useState } from "react";
import { DayPicker } from "./components/DayPicker.tsx";
import { QueueTab } from "./components/QueueTab.tsx";
import { StatsTab } from "./components/StatsTab.tsx";
import { HealthIndicator } from "./components/HealthIndicator.tsx";
import { jakartaDate } from "./day.ts";

const TABS = [
  { id: "queue", label: "Queue", empty: "No postings in the queue for this day." },
  { id: "answers", label: "Answers", empty: "No answers yet." },
  { id: "inbox", label: "Inbox", empty: "No unknown questions." },
  { id: "stats", label: "Stats", empty: "No stats for this day." },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App({ now = () => new Date() }: { now?: () => Date }) {
  const today = jakartaDate(now());
  const [day, setDay] = useState(today);
  const [tab, setTab] = useState<TabId>("queue");
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <>
      <header>
        <h1>job-agent dashboard</h1>
        <HealthIndicator />
      </header>
      <DayPicker day={day} today={today} onChange={setDay} />
      <div role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls="panel"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <main role="tabpanel" id="panel" aria-labelledby={`tab-${active.id}`}>
        <h2>{active.label}</h2>
        {active.id === "queue" ? (
          <QueueTab day={day} now={now} />
        ) : active.id === "stats" ? (
          <StatsTab day={day} />
        ) : (
          <p className="empty">
            {active.empty} ({day})
          </p>
        )}
      </main>
    </>
  );
}
