// The load-time check of a site's packages against this runtime and each
// other (docs/packages.md): npm's peer dependencies say which builds fit
// together, and an embedder's lockfile may still hold a set that does
// not, so the exec frame checks it again as it starts. What fails is
// ERUNTIME, as create()'s OTP and Elixir check is.
import { coerce, satisfies, validRange } from 'semver';
import declared from './host.json';
import { RUNTIME_PACKAGE, type SiteManifest } from './manifest';

// What this runtime is: its version (its major is the host ABI) and the
// versions of each seam it speaks.
export interface Host {
  name: string;
  version: string;
  provides: Record<string, number[]>;
}

export const HOST: Host = declared;

// OTP's versions have up to four parts (26.2.5.3), semver's three.
const loose = (version: string) => coerce(version)?.version ?? version;

// Whether a version is in a semver range.
export const fits = (version: string, range: string) =>
  validRange(range) !== null && satisfies(loose(version), range);

// What is wrong with the site for this runtime: nothing when it fits.
export function checkSite(site: SiteManifest, host: Host = HOST): string[] {
  const problems: string[] = [];
  if (!host.provides.manifest?.includes(site.manifest))
    return [`site.json is manifest ${site.manifest}; this runtime reads ${host.provides.manifest}`];
  const installed = (name: string) =>
    name === host.name ? host.version : site.packages[name]?.version;
  const all = Object.entries(site.packages);
  for (const [name, entry] of all) {
    const at = `${name}@${entry.version}`;
    for (const [peer, range] of Object.entries(entry.peerDependencies ?? {})) {
      const version = installed(peer);
      if (version === undefined) problems.push(`${at} needs ${peer} ${range}, which is missing`);
      else if (!fits(version, range)) problems.push(`${at} needs ${peer} ${range}, not ${version}`);
    }
    for (const [seam, version] of Object.entries(entry.playground.abi ?? {})) {
      const offered = host.provides[seam] ?? [];
      if (!offered.includes(version))
        problems.push(
          `${at} uses the ${seam} ABI ${version}; ${host.name}@${host.version} ` +
            (offered.length ? `speaks ${offered.join(', ')}` : 'has none'),
        );
    }
  }
  const one = (field: 'otp' | 'elixir') => {
    const found = all.filter(([, entry]) => entry.playground[field] !== undefined);
    if (found.length > 1)
      problems.push(`more than one ${field} package: ${found.map(([name]) => name).join(', ')}`);
    return found[0]?.[1] ?? null;
  };
  const otp = one('otp');
  const elixir = one('elixir');
  const range = elixir?.playground.requires?.otp;
  if (otp && range && !fits(otp.playground.otp!, range))
    problems.push(
      `Elixir ${elixir.playground.elixir} needs OTP ${range}, not ${otp.playground.otp}`,
    );
  for (const [name, entry] of all) {
    const template = entry.playground.template;
    if (!template) continue;
    if (otp && template.otp !== otp.playground.otp)
      problems.push(`${name} was compiled with OTP ${template.otp}, not ${otp.playground.otp}`);
    if (elixir && template.elixir !== elixir.playground.elixir)
      problems.push(
        `${name} was compiled with Elixir ${template.elixir}, not ${elixir.playground.elixir}`,
      );
  }
  for (const [name, entry] of all) {
    const layer = entry.playground.fs;
    if (!layer) continue;
    if (!host.provides.fs?.includes(layer.format))
      problems.push(
        `${name}@${entry.version}'s files are fs format ${layer.format}; ` +
          `this runtime reads ${host.provides.fs}`,
      );
    // Where its files go: an absolute, normalized path, not the root.
    if (!/^\/[^/]/.test(layer.root) || /\/$|\/\.\.?(\/|$)/.test(layer.root))
      problems.push(`${name}@${entry.version}'s files have no absolute root: ${layer.root}`);
  }
  // The boot images were recorded with exactly these packages.
  for (const [name, version] of Object.entries(site.boot?.packages ?? {}))
    if (installed(name) !== version)
      problems.push(
        `the boot images were recorded with ${name}@${version}, not ${installed(name) ?? 'none'}`,
      );
  const nifAbi = otp?.playground.nifAbi;
  if (nifAbi) {
    // The layer's protocol, which nif.ts speaks.
    const layer = Number(nifAbi.split('-')[0]);
    if (!host.provides.nif?.includes(layer))
      problems.push(
        `OTP's NIF ABI is ${nifAbi}; ${host.name}@${host.version} loads layer ` +
          `${host.provides.nif?.join(', ') || 'none'}`,
      );
  }
  return problems;
}

export function assertSite(site: SiteManifest, host: Host = HOST): void {
  const problems = checkSite(site, host);
  if (problems.length)
    throw Object.assign(
      new Error(
        `this site's packages do not fit ${RUNTIME_PACKAGE}@${host.version}: ${problems.join('; ')}`,
      ),
      { code: 'ERUNTIME' },
    );
}
