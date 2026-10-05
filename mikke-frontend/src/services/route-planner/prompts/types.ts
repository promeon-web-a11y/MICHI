/** AI に渡す Prompt の1つの版。version は、ログと結果（plan.planner.promptVersion）に残す */
export type PlannerPrompt = {
  version: string;
  schemaName: string;
  schema: unknown;
  system: string;
};
