import { redirect } from "next/navigation";
/** Sends the bare root URL to the default localized homepage.
 * Next.js invokes it when a visitor requests the root page. */
export default function IndexPage() {
  redirect("/en-us");
}
