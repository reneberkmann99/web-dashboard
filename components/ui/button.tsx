import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-accent px-4 py-2 text-slate-900 hover:bg-cyan-300",
        secondary: "bg-panelAlt px-4 py-2 text-text hover:bg-[#1a2947]",
        danger: "bg-danger px-4 py-2 text-white hover:bg-red-500",
        ghost: "px-3 py-2 hover:bg-panelAlt"
      },
      size: {
        default: "h-10",
        sm: "h-8 rounded px-3 text-xs",
        lg: "h-11 rounded-md px-6"
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
