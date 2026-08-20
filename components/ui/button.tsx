import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-control border border-transparent text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-hull disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "bg-brand px-4 py-2 text-brand-contrast hover:bg-brand-hover",
        secondary: "border-border bg-surface-raised px-4 py-2 text-text hover:border-border-strong hover:bg-surface-overlay",
        danger: "bg-critical px-4 py-2 text-white hover:bg-critical/85",
        warning: "bg-warning px-4 py-2 text-text-inverse hover:bg-warning/85",
        ghost: "px-3 py-2 text-text-muted hover:bg-surface-raised hover:text-text",
        outline: "border-border bg-transparent px-4 py-2 text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text"
      },
      size: {
        default: "h-control",
        sm: "h-control-sm px-3 text-xs",
        lg: "h-control-lg px-6"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
