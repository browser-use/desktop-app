export const APP_TITLE = 'Browser Use' as const;
export const INPUT_PLACEHOLDER = 'What should the agent do?' as const;
export const EMPTY_TITLE = 'No session selected' as const;
export const EMPTY_BODY = 'Choose a session from the sidebar, or start a new one.' as const;
export const EMPTY_SIDEBAR_TITLE = 'No sessions yet' as const;
export const EMPTY_SIDEBAR_BODY = 'Describe a task below to start your first agent session.' as const;

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  running: 'Running',
  stuck: 'Stuck',
  stopped: 'Stopped',
  idle: 'Idle',
};

export const STATUS_CSS_MODIFIER: Record<string, string> = {
  draft: 'draft',
  running: 'running',
  stuck: 'stuck',
  stopped: 'stopped',
};

export const OUTPUT_TYPE_LABEL: Record<string, string> = {
  thinking: 'Thinking',
  tool_call: 'Tool Call',
  tool_result: 'Result',
  text: 'Output',
  error: 'Error',
};
