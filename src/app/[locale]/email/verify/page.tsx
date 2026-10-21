import { Suspense } from "react";
import { EmailConfirmationPage } from "@/components/email-settings";
export const metadata = { referrer: "no-referrer" as const };
export default function Page() {
  return (
    <Suspense>
      <EmailConfirmationPage />
    </Suspense>
  );
}
