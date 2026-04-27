import assert from "node:assert/strict";
import test from "node:test";

import { formatOnCalendarLocal } from "../src/scheduler/systemd.js";

test("formatOnCalendarLocal matches systemd OnCalendar local-time shape", () => {
  const s = formatOnCalendarLocal(1_700_000_000_000);
  assert.match(
    s,
    /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,4}-\d{1,2}-\d{1,2} \d{1,2}:\d{1,2}:\d{1,2}$/,
    "expected: '<Weekday> YYYY-M-D H:M:S' (unpadded month/day/hour as systemd allows)",
  );
});

test("formatOnCalendarLocal is stable for a fixed offset (structure only)", () => {
  const a = formatOnCalendarLocal(1_000_000_000_000);
  const b = formatOnCalendarLocal(1_000_000_000_000);
  assert.equal(a, b);
});
