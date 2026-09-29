import type { Metadata } from "next";
import { IntelligenceCommandCenter } from "@/components/intelligence/IntelligenceCommandCenter";

export const metadata: Metadata = {
  title: "Business Intelligence",
};

export default function IntelligencePage() {
  return <IntelligenceCommandCenter />;
}
