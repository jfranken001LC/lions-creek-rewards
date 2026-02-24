// app/routes/_index.tsx
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  // If Shopify loads your app URL with ?shop=...&host=..., route into embedded admin app.
  if (url.searchParams.get("shop") && url.searchParams.get("host")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
}

export default function Index() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>Lions Creek Rewards</h1>
      <p>
        The app is running. If you expected the embedded admin UI, open the app
        from Shopify Admin so it supplies <code>shop</code> and <code>host</code>.
      </p>
    </main>
  );
}
