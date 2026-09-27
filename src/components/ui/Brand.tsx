import Image from "next/image";
import Link from "next/link";
import { APP_NAME, APP_TAGLINE, BRAND_ASSETS } from "@/config/brand";

export function Brand({
  compact = false,
  href = "/dashboard",
  showTagline = true,
}: {
  compact?: boolean;
  href?: string;
  showTagline?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`brand${compact ? " brand--compact" : ""}`}
      aria-label={`${APP_NAME} — главная`}
    >
      <Image
        src={BRAND_ASSETS.mark}
        alt=""
        width={40}
        height={40}
        className="brand__mark"
        priority
      />
      <span className="brand__text">
        <strong>{APP_NAME}</strong>
        {!compact && showTagline && <small>{APP_TAGLINE}</small>}
      </span>
    </Link>
  );
}

export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <Image
      src={BRAND_ASSETS.mark}
      alt=""
      width={size}
      height={size}
      className="brand__mark"
    />
  );
}
