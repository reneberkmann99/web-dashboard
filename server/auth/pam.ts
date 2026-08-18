/**
 * Client for the host-side HostPanel PAM authentication bridge.
 *
 * Security:
 * - Reaches the bridge over the Docker bridge gateway IP (never a public URL).
 * - Sends the shared X-Auth-Key on every request.
 * - Times out fast; any bridge failure is treated as auth failure (fail closed).
 * - Never logs the password.
 */

type PamAuthResult = {
  ok: boolean;
  displayName?: string;
};

export async function pamAuthenticate(username: string, password: string): Promise<PamAuthResult> {
  const baseUrl = process.env.PAM_BRIDGE_URL;
  const authKey = process.env.PAM_BRIDGE_KEY;

  if (!baseUrl || !authKey) {
    console.error("[PAM] PAM_BRIDGE_URL / PAM_BRIDGE_KEY not configured");
    return { ok: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(new URL("/auth", baseUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Key": authKey
      },
      body: JSON.stringify({ username, password }),
      signal: controller.signal,
      cache: "no-store"
    });

    if (!response.ok) {
      return { ok: false };
    }

    const data = (await response.json()) as { ok: boolean; displayName?: string };
    return { ok: Boolean(data.ok), displayName: data.displayName };
  } catch (error) {
    console.error("[PAM] bridge call failed:", error instanceof Error ? error.message : error);
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}
