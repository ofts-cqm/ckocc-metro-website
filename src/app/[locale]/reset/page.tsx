import { Suspense } from "react";
import { InvitationPage } from "@/components/auth-pages";
export const metadata = {
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};
export default function Page() {
  return (
    <Suspense>
      <InvitationPage reset />
    </Suspense>
  );
}
