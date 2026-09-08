import type { Clock } from "../runtime/clock.ts";
import { ConnectivityProbe } from "../runtime/network-pause.ts";

export interface StartConnectivityProbeOptions {
  clock: Clock;
  hosts: () => string[];
  intervalMs: number;
  onRecovered: () => Promise<void> | void;
}

export function toValidHostUrl(host: string): URL | null {
  if (/[\s/@?#\\]/.test(host)) return null;
  try {
    const url = new URL(`https://${host}/`);
    return url.username === "" && url.password === "" && url.pathname === "/" ? url : null;
  } catch {
    return null;
  }
}

export function startConnectivityProbe(options: StartConnectivityProbeOptions): { stop(): void } {
  async function probeHosts(): Promise<boolean | null> {
    const hosts = options.hosts();
    if (hosts.length === 0) return null;

    const urls = hosts.map(toValidHostUrl).filter((url): url is URL => url !== null);
    if (urls.length === 0) return null;

    try {
      await Promise.any(urls.map((url) => fetch(url, { signal: AbortSignal.timeout(options.intervalMs) })));
      return true;
    } catch {
      return false;
    }
  }

  const probe = new ConnectivityProbe({ clock: options.clock, probe: probeHosts, intervalMs: options.intervalMs });
  probe.onRecovered(() => {
    void options.onRecovered();
  });
  probe.start();

  return {
    stop: () => probe.stop(),
  };
}
