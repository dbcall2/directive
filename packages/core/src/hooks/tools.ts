/** Host spellings that install-time matchers and runtime classification share. */
export const DIRECT_WRITE_TOOL_NAMES = [
  "Edit",
  "Write",
  "WriteFile",
  "CreateFile",
  "MultiEdit",
  "NotebookEdit",
  "StrReplace",
  "SearchReplace",
  "Delete",
  "DeleteFile",
  "ApplyPatch",
  "apply_patch",
] as const;

function normalizedToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const DIRECT_WRITE_TOOLS = new Set(DIRECT_WRITE_TOOL_NAMES.map(normalizedToolName));

export function isDirectWriteTool(toolName: string): boolean {
  return DIRECT_WRITE_TOOLS.has(normalizedToolName(toolName));
}
