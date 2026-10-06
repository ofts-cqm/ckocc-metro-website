import { Suspense } from "react";
import { LoginPage } from "@/components/auth-pages";
export default function Page() {
  return (
    <Suspense>
      <LoginPage />
    </Suspense>
  );
}
