"use client";

import { usePathname, useRouter } from "next/navigation";
import { readRememberedReturn } from "@/components/navigation/view-state";

export function ContextBackLink({
  fallback,
  label,
  allowedReturnPrefixes = []
}: {
  fallback: string;
  label: string;
  allowedReturnPrefixes?: string[];
}): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();

  const goBack = (): void => {
    const remembered = readRememberedReturn(pathname);
    const allowed =
      remembered !== null &&
      (allowedReturnPrefixes.length === 0 || allowedReturnPrefixes.some((prefix) => remembered.startsWith(prefix)));
    if (allowed && window.history.length > 1) router.back();
    else router.push(fallback);
  };

  return (
    <button type="button" onClick={goBack} className="mb-2 text-sm text-brand hover:text-brand-hover">
      ← {label}
    </button>
  );
}
