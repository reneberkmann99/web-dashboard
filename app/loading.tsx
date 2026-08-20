import { NoderaftLogo } from "@/components/brand/noderaft-logo";

export default function Loading(): React.JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center p-gutter" aria-busy="true">
      <div className="text-center">
        <NoderaftLogo compact className="mx-auto animate-pulse" priority />
        <p className="mt-4 font-mono text-xs uppercase tracking-[0.16em] text-text-muted">Loading Noderaft</p>
      </div>
    </main>
  );
}
