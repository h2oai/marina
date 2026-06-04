import { RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/utils";

interface GlassPanelProps {
  title?: string;
  icon?: ReactNode;
  children: ReactNode;
  backContent?: ReactNode;
  className?: string;
  isFocused?: boolean;
  onDoubleClick?: () => void;
  headerExtra?: ReactNode;
}

const FLIP_TRANSITION = { duration: 0.4, ease: [0.4, 0, 0.2, 1] as const };

export function GlassPanel({
  title,
  icon,
  children,
  backContent,
  className,
  isFocused,
  onDoubleClick,
  headerExtra,
}: GlassPanelProps) {
  const [isFlipped, setIsFlipped] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={cn(
        "glass-panel flex h-full flex-col overflow-hidden",
        isFocused && "glass-panel-focused",
        className,
      )}
    >
      {title && (
        // biome-ignore lint/a11y/noStaticElementInteractions: react-grid-layout drag handle; double-click toggles focus and it wraps a nested flip button
        <div
          className="drag-handle flex cursor-grab items-center gap-1.5 border-b border-border px-2 py-1"
          onDoubleClick={onDoubleClick}
        >
          {icon && <span className="text-primary">{icon}</span>}
          <h2 className="flex-1 font-display text-[11px] font-semibold tracking-wider text-primary uppercase">
            {title}
          </h2>
          {headerExtra}
          {backContent && (
            <motion.button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsFlipped((f) => !f);
              }}
              animate={{ rotate: isFlipped ? 180 : 0 }}
              transition={FLIP_TRANSITION}
              className="text-text-dim hover:text-primary transition-colors"
              title={isFlipped ? "Show front" : "Show data"}
            >
              <RefreshCw size={10} />
            </motion.button>
          )}
        </div>
      )}
      {/* Body — 3D card flip on isFlipped toggle. Perspective on the
          parent gives the rotation depth. */}
      <div className="flex flex-1 flex-col overflow-hidden" style={{ perspective: 1200 }}>
        <AnimatePresence mode="wait" initial={false}>
          {isFlipped ? (
            <motion.div
              key="back"
              initial={{ rotateY: -90, opacity: 0 }}
              animate={{ rotateY: 0, opacity: 1 }}
              exit={{ rotateY: 90, opacity: 0 }}
              transition={FLIP_TRANSITION}
              style={{ backfaceVisibility: "hidden", transformOrigin: "center" }}
              className="flex flex-1 flex-col overflow-hidden overflow-y-auto"
            >
              {backContent}
            </motion.div>
          ) : (
            <motion.div
              key="front"
              initial={{ rotateY: 90, opacity: 0 }}
              animate={{ rotateY: 0, opacity: 1 }}
              exit={{ rotateY: -90, opacity: 0 }}
              transition={FLIP_TRANSITION}
              style={{ backfaceVisibility: "hidden", transformOrigin: "center" }}
              className="flex flex-1 flex-col overflow-hidden"
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
