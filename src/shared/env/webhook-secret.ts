export type WebhookSecretEnvKey =
  | 'CONFIO_WEBHOOK_KEY'
  | 'DROPI_WEBHOOK_SECRET'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'MP_WEBHOOK_SECRET'

export function readWebhookSecret(
  key: WebhookSecretEnvKey,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = env[key]
  return secret && secret !== 'CHANGEME' ? secret : null
}
