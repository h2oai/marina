// Copyright 2025-2026 H2O.ai, Inc.
// SPDX-License-Identifier: Apache-2.0

/**
 * One library thumbnail: the best small derivative the server picked
 * (`thumb`), a blurred inline placeholder while it loads, a shimmer while
 * previews are still being made (`derivativeState` null), and a type glyph
 * (plus a note) when no preview can be made.
 */

import {
  AlertTriangle,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { type AssetType, assetAltText, type LibraryItem } from "../../lib/asset-library";
import { useSignedAssetUrl } from "../../lib/asset-url";

const TYPE_ICON: Record<AssetType, LucideIcon> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  pdf: FileText,
  document: FileText,
  other: File,
};

const NO_PREVIEW = new Set(["unavailable", "failed"]);

export function AssetThumb({ item, size }: { item: LibraryItem; size: number }) {
  const thumb = item.thumb;
  const src = useSignedAssetUrl(thumb?.url, thumb?.expiresAt);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const Icon = TYPE_ICON[item.type] ?? File;
  const pending = !thumb && item.derivativeState === null && item.type !== "other";
  const unavailable = !thumb && NO_PREVIEW.has(item.derivativeState ?? "");
  const w = thumb?.width ?? item.width ?? size;
  const h = thumb?.height ?? item.height ?? size;

  return (
    <div
      className="relative flex items-center justify-center overflow-hidden rounded bg-bg-hover"
      style={{ width: size, height: size }}
    >
      {item.placeholder && !loaded && (
        <img
          src={item.placeholder}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full scale-110 object-cover blur-md"
        />
      )}
      {thumb && src && !failed && (
        <img
          src={src}
          alt={assetAltText(item)}
          width={w}
          height={h}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className="relative h-full w-full object-cover motion-safe:transition-opacity motion-safe:duration-200"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      )}
      {pending && (
        <div
          className="absolute inset-0 animate-pulse bg-gradient-to-r from-bg-hover via-bg-card to-bg-hover motion-reduce:animate-none"
          data-testid="thumb-pending"
        >
          <span className="sr-only">Preview is being made</span>
        </div>
      )}
      {(!thumb || failed) && !pending && (
        <Icon size={Math.max(18, size / 4)} className="text-text-dim" aria-hidden="true" />
      )}
      {unavailable && (
        <span
          className="absolute right-1 top-1 rounded bg-bg/80 p-0.5 text-warning"
          title={item.derivativeNote ?? "No preview available"}
          data-testid="thumb-unavailable"
        >
          <AlertTriangle size={11} aria-hidden="true" />
          <span className="sr-only">{item.derivativeNote ?? "No preview available"}</span>
        </span>
      )}
    </div>
  );
}
