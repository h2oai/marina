import { Wand2 } from "lucide-react";

/**
 * Small hover-reveal action bar overlaid on canvas nodes.
 * Uses Tailwind `group-hover` — parent must have `group` class.
 * Dispatches a custom event so CanvasPage can open the detail panel.
 */
export function NodeActionBar({ nodeId }: { nodeId: string }) {
  return (
    <div className="absolute bottom-1 right-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
      <button
        type="button"
        className="bg-gray-800/90 border border-gray-700 rounded p-1 text-gray-400 hover:text-cyan-400 transition-colors"
        title="Set intent — ask an agent to do something with this"
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("marina:open-detail", { detail: { nodeId } }));
        }}
      >
        <Wand2 size={14} />
      </button>
    </div>
  );
}
