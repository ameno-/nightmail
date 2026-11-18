// Rules were called rituals, and AI decisions omens, until the rename. Every rule operation still answers at its earlier
// name and path (/v1/rituals) as a deprecated alias with the same handler, request and response shapes and error codes,
// so clients written before it keep working. The aliases are never MCP tools: sessions list the new names.

/** Each rule operation and its deprecated alias. */
export const LEGACY_RULE_OPERATIONS = {
  getRules: 'getRituals', applyRules: 'applyRituals', attachRules: 'attachRituals', testRules: 'testRituals',
  getRule: 'getRitual', saveRule: 'saveRitual', deleteRule: 'deleteRitual', updateRule: 'updateRitual',
  checkRule: 'checkRitual', getRuleTypings: 'getRitualTypings', listRuleTemplates: 'listRitualTemplates',
  listRuleRecipes: 'listRitualRecipes', createRuleFromRecipe: 'createRitualFromRecipe', updateRuleFromRecipe: 'updateRitualFromRecipe',
  listRuleVersions: 'listRitualVersions', restoreRuleVersion: 'restoreRitualVersion', getRuleVersion: 'getRitualVersion',
  setDecisionOptIns: 'setOmenOptIns',
} as const;
export type RuleOperation = keyof typeof LEGACY_RULE_OPERATIONS;
export const RULES_PATH = '/v1/rules', LEGACY_RULES_PATH = '/v1/rituals';
/** The alias an operation ID names, with the operation it stands for. */
export const ruleAliases: ReadonlyMap<string, RuleOperation> = new Map(Object.entries(LEGACY_RULE_OPERATIONS).map(([id, old]) => [old, id as RuleOperation]));
