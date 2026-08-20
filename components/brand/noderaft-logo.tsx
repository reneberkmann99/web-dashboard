import Image from "next/image";
import { cn } from "@/lib/utils";

export function NoderaftLogo({
  className,
  compact = false,
  priority = false
}: {
  className?: string;
  compact?: boolean;
  priority?: boolean;
}): React.JSX.Element {
  if (compact) {
    return (
      <Image
        src="/brand/logo-mark.svg"
        width={64}
        height={64}
        alt="Noderaft"
        priority={priority}
        className={cn("h-8 w-8", className)}
      />
    );
  }

  return (
    <Image
      src="/brand/logo-horizontal-dark.svg"
      width={280}
      height={64}
      alt="Noderaft"
      priority={priority}
      className={cn("h-8 w-auto", className)}
    />
  );
}
