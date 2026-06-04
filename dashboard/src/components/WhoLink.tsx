import { ExternalLink } from "lucide-react";

/**
 * Small affordance pointing to the entity's public `/who/<name>` profile.
 *
 * Sits beside the existing in-dashboard entity-selection click target — the
 * button still selects the entity in the main panel; this link opens the
 * read-only blog/wiki view in a new tab. Two distinct mental models, two
 * distinct controls, no overloading.
 *
 * Renders as a dim icon-only link by default so it stays unobtrusive in
 * long lists. Hovering brightens it to signal "yes, this is clickable."
 */
export function WhoLink({
  name,
  className,
  size = 10,
}: {
  name: string;
  className?: string;
  size?: number;
}) {
  return (
    <a
      href={`/who/${encodeURIComponent(name)}`}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open ${name}'s public profile`}
      aria-label={`Open ${name}'s public profile`}
      // Stop the click from bubbling to a parent click handler (e.g. the
      // entity-select button in EntityRoster). The link should ONLY navigate.
      onClick={(e) => e.stopPropagation()}
      className={[
        "shrink-0 text-text-dim transition-colors hover:text-primary",
        "inline-flex items-center align-middle",
        className ?? "",
      ].join(" ")}
    >
      <ExternalLink size={size} aria-hidden="true" />
    </a>
  );
}
