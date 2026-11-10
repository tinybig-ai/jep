/** HA's Supervisor is the only peer allowed to assert an ingress identity. */
export function ingressIdentity(enabled: boolean, peer: string | undefined, raw: string | string[] | undefined): string | null {
  if (!enabled || peer?.replace(/^::ffff:/, "") !== "172.30.32.2" || Array.isArray(raw)) return null
  const value = raw?.trim() ?? ""
  return value && value.length <= 128 ? value : null
}
