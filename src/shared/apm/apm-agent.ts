export type ApmAttributes = Record<string, string | number | boolean>

/** The part of the New Relic agent API this service uses. */
export interface ApmAgent {
  recordCustomEvent(eventType: string, attributes: ApmAttributes): void
}

export const APM_AGENT = Symbol('APM_AGENT')

const silentAgent: ApmAgent = { recordCustomEvent: () => undefined }

/**
 * The agent `node -r newrelic` preloads when `NEW_RELIC_LICENSE_KEY` is set; without it, one that
 * records nothing, so the service starts and the package is never loaded.
 */
export function loadApmAgent(env: NodeJS.ProcessEnv = process.env): ApmAgent {
  if (!env.NEW_RELIC_LICENSE_KEY) return silentAgent
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('newrelic') as ApmAgent
}
