// Tests for src/lib/planTime.ts   Run: npm test
// The suite is run under several device time zones (see package.json) to prove the
// result never depends on the browser's time zone setting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  defaultPlanWindow,
  describePlanWindow,
  parseJstLocal,
  PLAN_TIME_MESSAGES,
  resolvePlanWindow,
  shiftEndWithStart,
  toJstIso,
  toJstLocal,
} from "../src/lib/planTime.ts";

const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const at = (iso) => new Date(iso);

// Re-run this whole file under other device time zones. POSIX-style names are used because
// Node on Windows ignores IANA names such as America/Los_Angeles in the TZ variable.
const DEVICE_TIME_ZONES = [
  ["UTC", 1],
  ["PST8PDT", 18], // America/Los_Angeles (UTC-7 in September)
  ["JST-9", 10], // Asia/Tokyo
];
if (!process.env.PLAN_TIME_TZ_CHILD) {
  const { spawnSync } = await import("node:child_process");
  for (const [tz, expectedHour] of DEVICE_TIME_ZONES) {
    test(`suite passes with device time zone TZ=${tz}`, () => {
      const run = spawnSync(process.execPath, ["--test", fileURLToPath(import.meta.url)], {
        env: { ...process.env, TZ: tz, PLAN_TIME_TZ_CHILD: String(expectedHour) },
        encoding: "utf8",
      });
      assert.equal(run.status, 0, run.stdout + run.stderr);
    });
  }
} else {
  test("the device time zone override is really in effect", () => {
    assert.equal(new Date("2026-09-24T01:00:00Z").getHours(), Number(process.env.PLAN_TIME_TZ_CHILD));
  });
}
// "Now" used by most tests: Thu 2026-09-24 09:00 JST
const NOW = at("2026-09-24T09:00:00+09:00");

test(`[${deviceTz}] 10:00〜15:00 is sent as JST with an explicit offset`, () => {
  const r = resolvePlanWindow("2026-09-24T10:00", "2026-09-24T15:00", NOW);
  assert.equal(r.ok, true);
  assert.equal(r.startIso, "2026-09-24T10:00:00+09:00");
  assert.equal(r.endIso, "2026-09-24T15:00:00+09:00");
  assert.equal(r.durationMinutes, 300);
  assert.equal(r.endAdjustedToNextDay, false);
});

test(`[${deviceTz}] 現在時刻〜3時間後 is accepted (including the form default)`, () => {
  const now = at("2026-09-24T13:37:42+09:00");
  const r = resolvePlanWindow(toJstLocal(now), toJstLocal(new Date(now.getTime() + 3 * 3600_000)), now);
  assert.equal(r.ok, true);
  assert.equal(r.startIso, "2026-09-24T13:37:00+09:00");
  assert.equal(r.endIso, "2026-09-24T16:37:00+09:00");
  const d = defaultPlanWindow(now);
  assert.deepEqual(d, { startAt: "2026-09-24T14:37", endAt: "2026-09-24T16:37" });
  assert.equal(resolvePlanWindow(d.startAt, d.endAt, now).ok, true);
});

test(`[${deviceTz}] 23:00〜翌01:00 works with the end date set to the next day`, () => {
  const r = resolvePlanWindow("2026-09-24T23:00", "2026-09-25T01:00", NOW);
  assert.equal(r.ok, true);
  assert.equal(r.durationMinutes, 120);
  assert.equal(r.endAdjustedToNextDay, false);
});

test(`[${deviceTz}] 23:00〜01:00 with the end date left on the same day is read as the next day`, () => {
  const r = resolvePlanWindow("2026-09-24T23:00", "2026-09-24T01:00", NOW);
  assert.equal(r.ok, true);
  assert.equal(r.endIso, "2026-09-25T01:00:00+09:00");
  assert.equal(r.endLocal, "2026-09-25T01:00");
  assert.equal(r.endAdjustedToNextDay, true);
  assert.equal(describePlanWindow(r), "9/24(木) 23:00 〜 9/25(金) 01:00（2時間）");
});

test(`[${deviceTz}] 開始＝終了 is rejected with a Japanese message`, () => {
  const r = resolvePlanWindow("2026-09-24T12:00", "2026-09-24T12:00", NOW);
  assert.equal(r.ok, false);
  assert.equal(r.message, "終了時間は開始時間より後に設定してください。");
});

test(`[${deviceTz}] 開始＞終了 is rejected (not silently turned into a 19-hour next-day plan)`, () => {
  const r = resolvePlanWindow("2026-09-24T15:00", "2026-09-24T10:00", NOW);
  assert.equal(r.ok, false);
  assert.equal(r.code, "end_not_after_start");
  // End on an earlier DATE is never rolled over.
  assert.equal(resolvePlanWindow("2026-09-25T10:00", "2026-09-24T12:00", NOW).code, "end_not_after_start");
});

test(`[${deviceTz}] 日付またぎ: form default created late at night crosses midnight correctly`, () => {
  const lateNight = at("2026-09-24T22:30:15+09:00");
  const d = defaultPlanWindow(lateNight);
  assert.deepEqual(d, { startAt: "2026-09-24T23:30", endAt: "2026-09-25T01:30" });
  const r = resolvePlanWindow(d.startAt, d.endAt, lateNight);
  assert.equal(r.ok, true);
  assert.equal(r.durationMinutes, 120);
  // Month / year boundary
  const nye = at("2026-12-31T22:00:00+09:00");
  const y = defaultPlanWindow(nye);
  assert.deepEqual(y, { startAt: "2026-12-31T23:00", endAt: "2027-01-01T01:00" });
  assert.equal(resolvePlanWindow(y.startAt, y.endAt, nye).ok, true);
});

test(`[${deviceTz}] JST <-> UTC conversion is exact and device-independent`, () => {
  assert.equal(parseJstLocal("2026-09-24T10:00").toISOString(), "2026-09-24T01:00:00.000Z");
  assert.equal(parseJstLocal("2026-09-25T01:00").toISOString(), "2026-09-24T16:00:00.000Z");
  assert.equal(parseJstLocal("2026-09-24T00:00").toISOString(), "2026-09-23T15:00:00.000Z");
  assert.equal(toJstLocal(at("2026-09-24T15:30:00Z")), "2026-09-25T00:30");
  assert.equal(toJstIso(at("2026-09-24T01:00:00Z")), "2026-09-24T10:00:00+09:00");
  assert.equal(parseJstLocal("2026-09-24T10:00:30").toISOString(), "2026-09-24T01:00:30.000Z");
});

test(`[${deviceTz}] missing / malformed / time-only input never reaches the server`, () => {
  assert.equal(resolvePlanWindow("", "2026-09-24T15:00", NOW).message, PLAN_TIME_MESSAGES.missing);
  assert.equal(resolvePlanWindow("2026-09-24T10:00", "", NOW).code, "missing");
  assert.equal(resolvePlanWindow("10:00", "15:00", NOW).code, "invalid_format"); // 日付情報なし
  assert.equal(resolvePlanWindow("2026-02-30T10:00", "2026-02-30T12:00", NOW).code, "invalid_format");
  assert.equal(resolvePlanWindow("2026-09-24T25:00", "2026-09-24T26:00", NOW).code, "invalid_format");
});

test(`[${deviceTz}] 当日の過去時刻 and over-long windows are rejected with Japanese messages`, () => {
  const evening = at("2026-09-24T21:20:00+09:00");
  assert.equal(resolvePlanWindow("2026-09-24T08:00", "2026-09-24T10:00", evening).code, "end_in_past");
  assert.equal(resolvePlanWindow("2026-09-24T18:00", "2026-09-24T23:00", evening).code, "start_in_past");
  assert.equal(resolvePlanWindow("2026-09-24T21:15", "2026-09-24T23:00", evening).ok, true); // 10-min grace
  assert.equal(resolvePlanWindow("2026-09-24T10:00", "2026-09-25T10:01", NOW).code, "too_long");
  for (const code of ["end_in_past", "start_in_past", "too_long"]) assert.match(PLAN_TIME_MESSAGES[code], /[ぁ-ん]/);
});

test(`[${deviceTz}] changing the start moves the end with it, so start > end cannot be produced that way`, () => {
  assert.equal(shiftEndWithStart("2026-09-24T10:00", "2026-09-24T12:00", "2026-09-24T14:00"), "2026-09-24T16:00");
  assert.equal(shiftEndWithStart("2026-09-24T10:00", "2026-09-24T12:00", "2026-09-24T23:30"), "2026-09-25T01:30");
  assert.equal(shiftEndWithStart("2026-09-24T12:00", "2026-09-24T10:00", "2026-09-24T13:00"), "2026-09-24T16:00"); // broken → default 3h
  assert.equal(shiftEndWithStart("2026-09-24T10:00", "2026-09-24T12:00", ""), "2026-09-24T12:00"); // cleared start: keep end
});

// Contract: whatever the form accepts, the deployed Edge Function validation accepts too.
const backendPlan = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../Mikke_Supabase_Backend_v0.1/mikke-supabase-backend/supabase/functions/generate-plan/plan.ts");
test(`[${deviceTz}] every window the form accepts passes the server's validateRequestedWindow`, { skip: !existsSync(backendPlan) }, async () => {
  const { validateRequestedWindow } = await import(pathToFileURL(backendPlan).href);
  const cases = [
    ["2026-09-24T10:00", "2026-09-24T15:00"],
    ["2026-09-24T23:00", "2026-09-25T01:00"],
    ["2026-09-24T23:00", "2026-09-24T01:00"],
    ["2026-09-24T09:00", "2026-09-24T12:00"],
    ["2026-09-24T08:55", "2026-09-24T09:30"],
  ];
  for (const [s, e] of cases) {
    const r = resolvePlanWindow(s, e, NOW);
    assert.equal(r.ok, true, `${s} ${e}`);
    const server = validateRequestedWindow(r.startIso, r.endIso, NOW);
    assert.equal(server.ok, true, `${s} ${e} -> ${JSON.stringify(server)}`);
  }
  // And the cases the form rejects are exactly the ones the server would reject as invalid_time_range.
  for (const [s, e] of [["2026-09-24T12:00", "2026-09-24T12:00"], ["2026-09-24T15:00", "2026-09-24T10:00"]]) {
    assert.equal(resolvePlanWindow(s, e, NOW).code, "end_not_after_start");
    assert.equal(validateRequestedWindow(`${s}:00+09:00`, `${e}:00+09:00`, NOW).error, "invalid_time_range");
  }
});
