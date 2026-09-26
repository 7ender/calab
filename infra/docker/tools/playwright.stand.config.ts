// Web e2e against the stand, bypassing local DNS/proxies (TESTING.md "Стенд", 2a): some VPN clients
// (fake-IP DNS + system HTTPS proxy) break exactly `colaba.gptunnel.ai`. With CALABA_FORCE_IP set,
// Chromium resolves every *.gptunnel.* name to that IP and connects directly; Firefox likewise.
//
//   cd apps/desktop && CALABA_FORCE_IP=141.105.69.177 CALABA_WEB_URL=https://colaba.gptunnel.ai \
//     CALABA_WEB_LOGIN=… CALABA_WEB_PASSWORD=… \
//     pnpm exec playwright test --config ../../infra/docker/tools/playwright.stand.config.ts
import path from 'node:path';
import base from '../../../apps/desktop/playwright.web.config';

const ip = process.env['CALABA_FORCE_IP'];

export default {
  ...base,
  // run from apps/desktop (see above): the spec directory and results live there
  testDir: path.resolve(process.cwd(), 'e2e-web'),
  outputDir: path.resolve(process.cwd(), 'test-results/stand'),
  projects: (base.projects ?? []).map((p) => {
    if (!ip) return p;
    const use = (p.use ?? {}) as Record<string, any>;
    const launch = (use['launchOptions'] ?? {}) as Record<string, any>;
    if (p.name === 'chromium') {
      return {
        ...p,
        use: {
          ...use,
          launchOptions: {
            ...launch,
            args: [
              ...(launch['args'] ?? []),
              `--host-resolver-rules=MAP *.gptunnel.ai ${ip}, MAP *.gptunnel.ru ${ip}, MAP colaba.gptunnel.ai ${ip}, MAP colaba.gptunnel.ru ${ip}`,
              '--proxy-server=direct://',
              '--proxy-bypass-list=*',
            ],
          },
        },
      };
    }
    // Firefox: no per-host mapping; the stand serves every name from one IP, so force all of them.
    return {
      ...p,
      use: {
        ...use,
        launchOptions: {
          ...launch,
          firefoxUserPrefs: { ...(launch['firefoxUserPrefs'] ?? {}), 'network.proxy.type': 0, 'network.dns.forceResolve': ip },
        },
      },
    };
  }),
};
