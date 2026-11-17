/**
 * Whether this deployment runs the self-evolution surface at all. Read live before every write,
 * so turning it off stops new drafts without a restart. Off unless the operator opts in.
 */
export function selfEvolutionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.SELF_EVOLUTION?.trim().toLowerCase();
  return value === "1" || value === "on" || value === "true";
}
