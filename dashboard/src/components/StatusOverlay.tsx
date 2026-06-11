import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

interface StatusOverlayProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

const overlayRoot =
  typeof window !== "undefined"
    ? (document.getElementById("status-overlay-root") ??
      (() => {
        const el = document.createElement("div");
        el.id = "status-overlay-root";
        document.body.appendChild(el);
        return el;
      })())
    : null;

export function StatusOverlay({ open, title, onClose, children, footer }: StatusOverlayProps) {
  if (!overlayRoot) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[1000] flex items-center justify-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            aria-label="Close status overlay"
            onClick={onClose}
          />
          <motion.div
            className="relative z-[1001] w-[min(520px,90vw)] max-h-[80vh] rounded-md border border-border bg-bg/95 shadow-2xl shadow-black/40"
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.94, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2 text-[12px] font-semibold uppercase tracking-wide text-text-dim">
              <span>{title}</span>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-text-dim transition-colors hover:text-primary"
                aria-label="Close status overlay"
              >
                <X size={12} />
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-4 py-3 text-[12px] text-text">
              {children}
            </div>
            {footer && (
              <div className="border-t border-border bg-bg/80 px-4 py-2 text-[11px] text-text-dim">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    overlayRoot,
  );
}
