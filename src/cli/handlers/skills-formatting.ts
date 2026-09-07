export type SkillMutationVerb = 'install' | 'update'

/** Render the exact argv a real run spawns, so --dry-run can never drift from it. */
export function formatNpxCommand(args: string[]): string {
  return `npx ${args.join(' ')}`
}

export function formatSkillSelectionHelp(verb: SkillMutationVerb, skillNames: string[]): string {
  return [
    `Choose one or more skills to ${verb}:`,
    ...skillNames.map((name) => `  ${name}`),
    '',
    `Usage: orca skills ${verb} --skill <name> [--skill <name> ...]`,
    `   or: orca skills ${verb} --all`
  ].join('\n')
}
