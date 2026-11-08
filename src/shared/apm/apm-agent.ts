export type ApmAttributes = Record<string, string | number | boolean>

/** The part of the New Relic agent API this service uses. */
export interface ApmAgent {
  recordCustomEvent(eventType: string, attributes: ApmAttributes): void
}

export const APM_AGENT = Symbol('APM_AGENT')

const silentAgent: ApmAgent = { recordCustomEvent: () => undefined }

/**
 * The agent `start:prod` and `start:stag` preload with `node -r newrelic` when
 * `NEW_RELIC_LICENSE_KEY` is set. Without it, one that records nothing: the preloaded agent does
 * not connect, the service still starts, and this code never requires the package.
 */
export function loadApmAgent(env: NodeJS.ProcessEnv = process.env): ApmAgent {
  if (!env.NEW_RELIC_LICENSE_KEY) return silentAgent
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('newrelic') as ApmAgent
}
