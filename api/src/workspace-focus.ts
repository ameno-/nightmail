// What a workspace said it is here for (onboarding's "What do you want to do?", Settings): the first leads, and the
// dashboard tailors onboarding's next step, Overview's first card and its Get started steps to it. personal: an inbox of
// their own, on their own domain. No imports: the dashboard bundles this file.
export const WORKSPACE_FOCUS = ['marketing', 'newsletter', 'developer', 'agents', 'personal'] as const;
export type WorkspaceFocus = typeof WORKSPACE_FOCUS[number];
