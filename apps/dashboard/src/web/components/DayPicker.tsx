import { isDay } from "../day.ts";

export function DayPicker({
  day,
  today,
  onChange,
}: {
  day: string;
  today: string;
  onChange: (day: string) => void;
}) {
  return (
    <label>
      Day (Asia/Jakarta)
      <input
        type="date"
        value={day}
        max={today}
        onChange={(e) => {
          if (isDay(e.target.value)) onChange(e.target.value);
        }}
      />
    </label>
  );
}
