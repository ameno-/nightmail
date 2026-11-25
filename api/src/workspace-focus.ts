// What a workspace said it is here for (onboarding's "What do you want to focus on?", Settings): the first leads, and the
// dashboard tailors onboarding's next step, Overview's first card and its Get started steps to it. No imports: the
// dashboard bundles this file.
export const WORKSPACE_FOCUS = ['marketing', 'newsletter', 'developer', 'agents'] as const;
export type WorkspaceFocus = typeof WORKSPACE_FOCUS[number];
