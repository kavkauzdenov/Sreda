import Image from "next/image";
import {
  solutionModuleAsset,
  solutionVisualCode,
} from "@/config/solutionPresentation";

export type SolutionIconCode =
  | "orders"
  | "leads"
  | "booking"
  | "messages"
  | "admin_messages"
  | "autopost"
  | "sales"
  | (string & {});

/** Catalog / dashboard plate — keep modest for card art. */
const HERO_PX = { width: 160, height: 160 } as const;
/** Setup / solution page intro — sized for crisp display up to ~360–400 CSS px. */
const FEATURE_PX = { width: 640, height: 520 } as const;
const COMPACT_PX = { width: 64, height: 64 } as const;

/**
 * Brand solution icons (3D soft-clay set).
 * System UI icons (search, bell, chevron, …) stay Lucide — do not reuse this.
 */
export function SolutionIcon({
  solution,
  variant = "hero",
  className = "",
  alt = "",
}: {
  solution: SolutionIconCode;
  variant?: "hero" | "compact" | "feature";
  className?: string;
  alt?: string;
}) {
  const visual = solutionVisualCode(String(solution));
  const src = solutionModuleAsset(visual);
  const size =
    variant === "compact"
      ? COMPACT_PX
      : variant === "feature"
        ? FEATURE_PX
        : HERO_PX;
  return (
    <span
      className={`biznesoty-solution-icon biznesoty-solution-icon--${variant} biznesoty-solution-icon--${visual}${className ? ` ${className}` : ""}`}
      data-solution={visual}
      data-variant={variant}
    >
      <Image
        src={src}
        alt={alt}
        width={size.width}
        height={size.height}
        sizes={
          variant === "compact"
            ? "(max-width: 768px) 28px, 36px"
            : variant === "feature"
              ? "(max-width: 767px) 96px, (max-width: 1024px) 220px, 320px"
              : "(max-width: 768px) 56px, 88px"
        }
        unoptimized
        draggable={false}
      />
    </span>
  );
}
