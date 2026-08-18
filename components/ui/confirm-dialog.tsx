"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";

/**
 * Confirmation dialog with a clearly identified target and a stated impact.
 * Never uses the browser-native confirm().
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  impact,
  confirmLabel = "Confirm",
  danger = true,
  busy = false
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  impact: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
}): React.JSX.Element | null {
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm(): Promise<void> {
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={danger ? "danger" : "default"} onClick={() => void handleConfirm()} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">{impact}</p>
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </Modal>
  );
}
