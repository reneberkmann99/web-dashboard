import { PageHeader } from "@/components/ui/page-header";

export default function PlatformSettingsPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Platform" title="Platform Settings" description="Control-plane defaults and platform-wide configuration." />
      <section className="rounded-lg border border-border bg-panel p-5">
        <h2 className="font-medium">Platform configuration</h2>
        <p className="mt-1 text-sm text-muted">Platform settings will appear here as they become configurable. Organization settings remain scoped to each organization.</p>
      </section>
    </div>
  );
}
