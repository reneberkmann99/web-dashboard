// The installed `psl` package's package.json `exports` map has no "types"
// condition, so TypeScript (moduleResolution: bundler) can't resolve its
// bundled types/index.d.ts even though the legacy top-level `types` field
// points at it — a known upstream packaging gap. This ambient declaration
// covers just the one function server/services/domains.ts actually calls.
declare module "psl" {
  export function get(domain: string): string | null;
}
