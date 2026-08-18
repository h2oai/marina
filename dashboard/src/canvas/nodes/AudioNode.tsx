// Copyright 2025-2026 Marina Contributors
// SPDX-License-Identifier: Apache-2.0

import { Handle, type NodeProps, NodeResizer, Position } from "@xyflow/react";
import { useEffect, useRef, useState } from "react";
import { emptyAssetLabel } from "../lib/node-fields";
import { NodeMeta } from "./NodeMeta";

export function AudioNode({ data, selected }: NodeProps) {
  const url = (data.url as string) ?? "";
  const filename = (data.filename as string) ?? "Audio";
  const mime = (data.mime as string) ?? "audio/mpeg";
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const [playing, setPlaying] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    const audio = audioRef.current;
    const canvas = canvasRef.current;
    if (!audio || !canvas || !url) return;

    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let source: MediaElementAudioSourceNode | null = null;
    let initialized = false;

    function init() {
      if (initialized || !audio) return;
      initialized = true;
      ctx = new AudioContext();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);
    }

    function draw() {
      if (!analyser || !canvas) return;
      const canvasCtx = canvas.getContext("2d")!;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyser.getByteFrequencyData(dataArray);

      canvasCtx.fillStyle = "#111827";
      canvasCtx.fillRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 2;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i]! / 255) * canvas.height;
        const hue = 140 + (i / bufferLength) * 40;
        canvasCtx.fillStyle = `hsl(${hue}, 80%, ${40 + (dataArray[i]! / 255) * 30}%)`;
        canvasCtx.fillRect(x, canvas.height - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }

      animRef.current = requestAnimationFrame(draw);
    }

    const onPlay = () => {
      init();
      if (ctx?.state === "suspended") ctx.resume();
      setPlaying(true);
      draw();
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(animRef.current);
    };

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onPause);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onPause);
      cancelAnimationFrame(animRef.current);
    };
  }, [url]);

  return (
    <div className="rounded-lg overflow-hidden bg-bg-card border border-green-800/50 shadow-lg shadow-green-900/20 p-3 h-full flex flex-col">
      <NodeResizer
        isVisible={!!selected}
        minWidth={200}
        minHeight={100}
        lineClassName="!border-green-500/50"
        handleClassName="!w-2 !h-2 !bg-green-500 !border-green-400"
      />
      <Handle type="target" position={Position.Top} className="!bg-green-500" />
      {selected && <NodeMeta filename={filename} data={data} className="mb-2" />}
      {url && !errored ? (
        <>
          <canvas
            ref={canvasRef}
            width={260}
            height={60}
            className={`w-full rounded mb-2 ${playing ? "" : "opacity-40"}`}
          />
          {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded audio has no caption track */}
          <audio
            ref={audioRef}
            controls
            className="nodrag w-full"
            preload="metadata"
            crossOrigin="anonymous"
            onError={() => setErrored(true)}
          >
            <source src={url} type={mime} />
          </audio>
        </>
      ) : (
        <div className="flex flex-col items-center justify-center flex-1 text-text-dim text-sm gap-1 px-2 text-center py-2">
          <span>{emptyAssetLabel("audio", errored)}</span>
          {errored && filename && (
            <span className="text-xs text-text-dim truncate max-w-full" title={filename}>
              {filename}
            </span>
          )}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-green-500" />
    </div>
  );
}
