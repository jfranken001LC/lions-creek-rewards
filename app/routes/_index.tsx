import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  // Preserve shop/host params Shopify passes
  return redirect(`/app${url.search}`);
};

export default function Index() {
  return null;
}
