import * as React from "react";
import { Check } from "lucide-react";
import { cn } from "@client/lib/utils";

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  onCheckedChange?: (checked: boolean) => void;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, onCheckedChange, onChange, ...props }, ref) => {
    return (
      <label className="relative inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          className="sr-only peer"
          ref={ref}
          onChange={(e) => {
            onChange?.(e);
            onCheckedChange?.(e.target.checked);
          }}
          {...props}
        />
        {/* The Check icon must be a direct sibling of the input (not nested inside this div) --
            Tailwind's peer-checked general-sibling selector only matches elements sharing the
            input's parent, not descendants of a sibling. */}
        <div className={cn(
          "absolute inset-0 rounded border transition-colors",
          "border-border bg-background",
          "peer-checked:border-primary peer-checked:bg-primary",
          className
        )} />
        <Check
          size={12}
          strokeWidth={3}
          className="pointer-events-none relative z-10 text-primary-foreground opacity-0 transition-opacity peer-checked:opacity-100"
        />
      </label>
    );
  }
);
Checkbox.displayName = "Checkbox";

export { Checkbox };
