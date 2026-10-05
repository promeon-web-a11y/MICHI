// いま使う Prompt の版。版を切り替える・比べる（A/B）ときは、ここで選ぶ。
// planRoute には deps.prompts で別の版を渡せる（評価用のスクリプトやテストから）。
import { INTERPRET_REQUEST_V1 } from "./interpret-request";
import { ROUTE_PLANNER_V1 } from "./route-planner";
import type { PlannerPrompt } from "./types";

export type PlannerPrompts = { planner: PlannerPrompt; interpreter: PlannerPrompt };

export const ACTIVE_PROMPTS: PlannerPrompts = {
  planner: ROUTE_PLANNER_V1,
  interpreter: INTERPRET_REQUEST_V1,
};

export { INTERPRET_REQUEST_V1, ROUTE_PLANNER_V1 };
export type { PlannerPrompt };
