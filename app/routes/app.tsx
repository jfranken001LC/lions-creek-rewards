import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import {
  Link,
  Outlet,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
} from "react-router";

/**
 * For embedded apps, Shopify needs stable query params (host/shop/embedded).
 * Do NOT carry ephemeral params forward (hmac/timestamp/session/id_token).
 */
function buildEmbeddedSearch(search: string): string {
  const params = new URLSearchParams(search);
  const keep = new URLSearchParams();

  for (const key of ["embedded", "host", "shop", "locale"]) {
    const v = params.get(key);
    if (v) keep.set(key, v);
  }

  const qs = keep.toString();
  return qs ? `?${qs}` : "";
}

export default function App() {
  const apiKey = import.meta.env.VITE_SHOPIFY_API_KEY as string | undefined;
  const location = useLocation();

  if (!apiKey) {
    return (
      <main
        style={{
          fontFamily: "system-ui",
          padding: 24,
          maxWidth: 900,
          margin: "0 auto",
        }}
      >
        <h1 style={{ marginTop: 0 }}>BasketBooster – Misconfigured build</h1>

        <p style={{ fontSize: 16, lineHeight: 1.5 }}>
          This build is missing <code>VITE_SHOPIFY_API_KEY</code>.
        </p>

        <ol style={{ lineHeight: 1.6 }}>
          <li>
            Set <code>VITE_SHOPIFY_API_KEY</code> at build time (should match your
            Partner dashboard <em>Client ID</em>).
          </li>
          <li>Rebuild and redeploy.</li>
        </ol>

        <p style={{ color: "#666" }}>
          Current route:{" "}
          <code>
            {location.pathname}
            {location.search}
          </code>
        </p>
      </main>
    );
  }

  const embeddedSearch = buildEmbeddedSearch(location.search);
  const to = (pathname: string) => `${pathname}${embeddedSearch}`;

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to={to("/app")} rel="home">
          Home
        </Link>
        <Link to={to("/app/additional")}>Additional page</Link>
      </NavMenu>

      <div style={{ minHeight: "100vh" }}>
        <Outlet />
      </div>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  let title = "Something went wrong";
  let details: string | undefined;

  if (isRouteErrorResponse(error)) {
    title = `${error.status} ${error.statusText}`;
    if (typeof error.data === "string") details = error.data;
    else if (error.data) details = JSON.stringify(error.data, null, 2);
  } else if (error instanceof Error) {
    details = error.stack || error.message;
  } else if (error) {
    details = JSON.stringify(error, null, 2);
  }

  return (
    <main
      style={{
        fontFamily: "system-ui",
        padding: 24,
        maxWidth: 900,
        margin: "0 auto",
      }}
    >
      <h1 style={{ marginTop: 0 }}>{title}</h1>

      <p style={{ fontSize: 16, lineHeight: 1.5 }}>
        The embedded shell is running, but a UI route threw an exception. Fix the
        error in the route component that rendered this page.
      </p>

      {details ? (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            background: "#f6f6f7",
            padding: 16,
            borderRadius: 12,
            overflowX: "auto",
          }}
        >
          {details}
        </pre>
      ) : null}
    </main>
  );
}
