/** A client address no other request here has, near enough. */
export const freshIp = () => `10.${crypto.getRandomValues(new Uint8Array(3)).join(".")}`;

/**
 * `init` as a request from a new client, unless it names its own: the limit on originals counts
 * per client, and a file's requests without an address would all share one count.
 */
export function asNewClient(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", freshIp());
  return { ...init, headers };
}
