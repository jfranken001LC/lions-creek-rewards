import type { Route } from "./+types/root";
import { isRouteErrorResponse, useRouteError } from "react-router";

import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

export const links = () => [
  { rel: "stylesheet", href: polarisStyles },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

function formatRouteError(error: unknown): { title: string; details?: string } {
  if (isRouteErrorResponse(error)) {
    const details =
      "data" in error && error.data
        ? (typeof error.data === "string" ? error.data : JSON.stringify(error.data, null, 2))
        : undefined;

    return {
      title: `${error.status} ${error.statusText}`,
      details,
    };
  }

  if (error instanceof Error) {
    return {
      title: error.name || "Unexpected error",
      details: error.stack ?? error.message,
    };
  }

  return {
    title: "Unexpected error",
    details: error ? JSON.stringify(error, null, 2) : undefined,
  };
}

export function ErrorBoundary() {
  const error = useRouteError();
  const { title, details } = formatRouteError(error);

  return (
    <div style={{
      fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
      padding: 24,
      maxWidth: 980,
      margin: "0 auto",
      lineHeight: 1.4,
    }}>
      <h1 style={{ margin: "0 0 8px" }}>{title}</h1>
      <p style={{ margin: "0 0 16px", opacity: 0.8 }}>
        If you reached this page via Shopify CLI preview, it usually means your preview URL is pointing at the production domain instead of the active dev tunnel.
      </p>
      {details ? (
        <pre style={{
          whiteSpace: "pre-wrap",
          background: "rgba(0,0,0,0.04)",
          padding: 16,
          borderRadius: 12,
          overflowX: "auto",
        }}>
          {details}
        </pre>
      ) : null}
    </div>
  );
}
