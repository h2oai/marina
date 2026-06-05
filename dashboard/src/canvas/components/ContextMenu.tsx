import { Trash2, Wand2 } from "lucide-react";
import { motion } from "motion/react";

interface Props {
  x: number;
  y: number;
  nodeId: string;
  onSetIntent: () => void;
  onDelete: () => void;
  onClose: () => void;
}

export function ContextMenu({ x, y, onSetIntent, onDelete, onClose }: Props) {
  return (
    <>
      {/* Invisible backdrop to catch clicks */}
      <button
        type="button"
        aria-label="Close context menu"
        className="fixed inset-0 z-40 cursor-default"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.92, y: 2 }}
        transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
        className="fixed z-50 bg-bg-hover border border-border rounded-lg shadow-xl py-1 min-w-[160px]"
        style={{ left: x, top: y, transformOrigin: "top left" }}
      >
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text hover:bg-bg-hover hover:text-primary transition-colors"
          onClick={() => {
            onSetIntent();
            onClose();
          }}
        >
          <Wand2 size={13} />
          Set Intent
        </button>
        <div className="border-t border-border my-0.5" />
        <button
          type="button"
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text hover:bg-bg-hover hover:text-red-400 transition-colors"
          onClick={() => {
            onDelete();
            onClose();
          }}
        >
          <Trash2 size={13} />
          Delete
        </button>
      </motion.div>
    </>
  );
}
