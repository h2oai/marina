import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { useCallback, useState } from "react";
import { authFetch } from "../../lib/api";
import { NodeMeta } from "./NodeMeta";

const API_BASE = window.location.origin;

export function DocumentNode({ data, id, selected }: NodeProps) {
  const content = (data.content as string) ?? (data.body as string) ?? "";
  const filename = (data.filename as string) ?? "Document";
  const canvasId = data.canvas_id as string | undefined;
  const [editing, setEditing] = useState(false);

  const editor = useEditor({
    extensions: [StarterKit],
    content: content || "<p>Empty document</p>",
    editable: editing,
    editorProps: {
      attributes: {
        class: "prose prose-sm prose-invert max-w-none p-3 focus:outline-none min-h-[100px]",
      },
    },
  });

  const save = useCallback(async () => {
    if (!editor || !canvasId) return;
    const html = editor.getHTML();
    try {
      await authFetch(`${API_BASE}/api/canvases/${canvasId}/nodes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { content: html, filename } }),
      });
    } catch {
      // Silent fail
    }
    setEditing(false);
  }, [editor, canvasId, id, filename]);

  return (
    <div className="rounded-lg overflow-hidden bg-gray-900 border border-blue-800/50 shadow-lg shadow-blue-900/20 flex flex-col h-full">
      <NodeResizer
        isVisible={!!selected}
        minWidth={200}
        minHeight={150}
        lineClassName="!border-blue-500/50"
        handleClassName="!w-2 !h-2 !bg-blue-500 !border-blue-400"
      />
      <Handle type="target" position={Position.Top} className="!bg-blue-500" />
      {selected && (
        <div className="px-3 py-1.5 bg-blue-900/30 text-xs text-blue-300 font-medium truncate flex items-center justify-between">
          <NodeMeta filename={filename} data={data} />
          <div className="flex gap-1 shrink-0 ml-2">
            {editing ? (
              <button type="button" onClick={save} className="text-green-400 hover:text-green-300">
                Save
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditing(true);
                  editor?.setEditable(true);
                }}
                className="text-blue-400 hover:text-blue-300"
              >
                Edit
              </button>
            )}
          </div>
        </div>
      )}
      <div className="flex-1 overflow-auto text-sm text-gray-300">
        {editor ? (
          <EditorContent editor={editor} />
        ) : (
          <div className="p-3 whitespace-pre-wrap">
            {content || <span className="text-gray-600 italic">Empty document</span>}
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} className="!bg-blue-500" />
    </div>
  );
}
